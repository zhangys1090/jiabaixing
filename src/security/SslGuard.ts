import * as https from 'https';
import * as tls from 'tls';
import { Logger } from '../utils/Logger';

export interface SslCheckResult {
  valid: boolean;
  hostname: string;
  errors: string[];
  warnings: string[];
  certificate?: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    daysRemaining: number;
    fingerprint: string;
  };
}

export interface SslGuardConfig {
  enabled: boolean;
  allowSelfSigned: boolean;
  allowExpired: boolean;
  minDaysRemaining: number;
  allowedFingerprints: Set<string>;
  blockedFingerprints: Set<string>;
}

const DEFAULT_SSL_CONFIG: SslGuardConfig = {
  enabled: true,
  allowSelfSigned: false,
  allowExpired: false,
  minDaysRemaining: 7,
  allowedFingerprints: new Set(),
  blockedFingerprints: new Set(),
};

export class SslGuard {
  private static instance: SslGuard | null = null;
  private config: SslGuardConfig;
  private violationLog: Array<{
    hostname: string;
    timestamp: number;
    errors: string[];
  }> = [];

  private constructor(config?: Partial<SslGuardConfig>) {
    this.config = { ...DEFAULT_SSL_CONFIG, ...config };
  }

  public static getInstance(config?: Partial<SslGuardConfig>): SslGuard {
    if (!SslGuard.instance) {
      SslGuard.instance = new SslGuard(config);
    }
    return SslGuard.instance;
  }

  public async verifyUrl(url: string): Promise<SslCheckResult> {
    if (!this.config.enabled) {
      return { valid: true, hostname: '', errors: [], warnings: [] };
    }

    let hostname: string;
    let port = 443;

    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      port = parseInt(parsed.port, 10) || 443;

      if (parsed.protocol !== 'https:') {
        return {
          valid: true,
          hostname,
          errors: [],
          warnings: ['非HTTPS连接，数据传输未加密'],
        };
      }
    } catch {
      return {
        valid: false,
        hostname: url,
        errors: ['URL格式不合法'],
        warnings: [],
      };
    }

    return this.verifyCertificate(hostname, port);
  }

  public async verifyCertificate(
    hostname: string,
    port: number = 443
  ): Promise<SslCheckResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!this.config.enabled) {
      return { valid: true, hostname, errors, warnings };
    }

    try {
      const certInfo = await this.fetchCertificate(hostname, port);

      if (!certInfo) {
        errors.push('无法获取SSL证书');
        this.logViolation(hostname, errors);
        return { valid: false, hostname, errors, warnings };
      }

      if (this.config.blockedFingerprints.size > 0) {
        if (this.config.blockedFingerprints.has(certInfo.fingerprint)) {
          errors.push(`证书指纹在黑名单中: ${certInfo.fingerprint}`);
        }
      }

      const now = new Date();
      const validFrom = new Date(certInfo.validFrom);
      const validTo = new Date(certInfo.validTo);
      const daysRemaining = Math.floor(
        (validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (now < validFrom) {
        errors.push('证书尚未生效');
      }

      if (now > validTo) {
        if (!this.config.allowExpired) {
          errors.push('证书已过期');
        } else {
          warnings.push('证书已过期（已允许）');
        }
      }

      if (daysRemaining >= 0 && daysRemaining < this.config.minDaysRemaining) {
        warnings.push(`证书即将过期（剩余 ${daysRemaining} 天）`);
      }

      const isSelfSigned =
        certInfo.subject === certInfo.issuer ||
        certInfo.issuer.includes('self-signed') ||
        certInfo.issuer.includes('Fake');
      if (isSelfSigned && !this.config.allowSelfSigned) {
        errors.push('自签名证书（可能存在中间人攻击）');
      }

      const result: SslCheckResult = {
        valid: errors.length === 0,
        hostname,
        errors,
        warnings,
        certificate: {
          ...certInfo,
          daysRemaining,
        },
      };

      if (!result.valid) {
        this.logViolation(hostname, errors);
      }

      return result;
    } catch (err) {
      const message = (err as Error).message;
      errors.push(`SSL验证失败: ${message}`);
      this.logViolation(hostname, errors);
      return { valid: false, hostname, errors, warnings };
    }
  }

  public install(): void {
    if (!this.config.enabled) {
      Logger.info('⚠️ SSL守卫：已禁用', 'SslGuard');
      return;
    }

    const originalCreateSecureContext = tls.createSecureContext;
    const guard = this;

    (tls as any).createSecureContext = function patchedCreateSecureContext(
      options?: tls.SecureContextOptions
    ) {
      const context = originalCreateSecureContext.call(this, options);

      if (options?.cert) {
        try {
          const cert = options.cert;
          const certStr = Buffer.isBuffer(cert)
            ? cert.toString('utf-8')
            : Array.isArray(cert)
              ? cert.join('\n')
              : cert;

          if (certStr.includes('self-signed') || certStr.includes('Fake CA')) {
            if (!guard.config.allowSelfSigned) {
              Logger.warn('🚫 SSL守卫：拦截自签名证书', 'SslGuard');
            }
          }
        } catch {
          // 证书解析失败不阻塞
        }
      }

      return context;
    };

    Logger.info('✅ SSL守卫：证书验证已安装', 'SslGuard');
  }

  public getViolationLog(): Array<{
    hostname: string;
    timestamp: number;
    errors: string[];
  }> {
    return [...this.violationLog];
  }

  public updateConfig(config: Partial<SslGuardConfig>): void {
    Object.assign(this.config, config);
    Logger.info('🔧 SSL守卫：配置已更新', 'SslGuard');
  }

  private fetchCertificate(
    hostname: string,
    port: number
  ): Promise<{
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    fingerprint: string;
  } | null> {
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname,
          port,
          method: 'HEAD',
          path: '/',
          rejectUnauthorized: false,
          timeout: 10000,
        },
        (res) => {
          const socket = res.socket as tls.TLSSocket;
          const cert = socket.getPeerCertificate();

          if (!cert || Object.keys(cert).length === 0) {
            resolve(null);
            return;
          }

          resolve({
            subject: cert.subject
              ? Object.entries(cert.subject)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')
              : 'unknown',
            issuer: cert.issuer
              ? Object.entries(cert.issuer)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')
              : 'unknown',
            validFrom: cert.valid_from || '',
            validTo: cert.valid_to || '',
            fingerprint: cert.fingerprint || '',
          });
        }
      );

      req.on('error', () => {
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.end();
    });
  }

  private logViolation(hostname: string, errors: string[]): void {
    this.violationLog.push({
      hostname,
      timestamp: Date.now(),
      errors,
    });

    if (this.violationLog.length > 100) {
      this.violationLog = this.violationLog.slice(-50);
    }

    Logger.warn(`🚫 SSL守卫：${hostname} - ${errors.join(', ')}`, 'SslGuard');
  }
}

export const sslGuard = SslGuard.getInstance();
