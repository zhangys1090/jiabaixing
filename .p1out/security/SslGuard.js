"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sslGuard = exports.SslGuard = void 0;
const https = __importStar(require("https"));
const tls = __importStar(require("tls"));
const Logger_1 = require("../utils/Logger");
const DEFAULT_SSL_CONFIG = {
    enabled: true,
    allowSelfSigned: false,
    allowExpired: false,
    minDaysRemaining: 7,
    allowedFingerprints: new Set(),
    blockedFingerprints: new Set(),
};
class SslGuard {
    constructor(config) {
        this.violationLog = [];
        this.config = { ...DEFAULT_SSL_CONFIG, ...config };
    }
    static getInstance(config) {
        if (!SslGuard.instance) {
            SslGuard.instance = new SslGuard(config);
        }
        return SslGuard.instance;
    }
    async verifyUrl(url) {
        if (!this.config.enabled) {
            return { valid: true, hostname: '', errors: [], warnings: [] };
        }
        let hostname;
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
        }
        catch (err) {
            Logger_1.Logger.debug(`SSL验证URL解析失败: ${err?.message}`, 'SslGuard');
            return {
                valid: false,
                hostname: url,
                errors: ['URL格式不合法'],
                warnings: [],
            };
        }
        return this.verifyCertificate(hostname, port);
    }
    async verifyCertificate(hostname, port = 443) {
        const errors = [];
        const warnings = [];
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
            const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            if (now < validFrom) {
                errors.push('证书尚未生效');
            }
            if (now > validTo) {
                if (!this.config.allowExpired) {
                    errors.push('证书已过期');
                }
                else {
                    warnings.push('证书已过期（已允许）');
                }
            }
            if (daysRemaining >= 0 && daysRemaining < this.config.minDaysRemaining) {
                warnings.push(`证书即将过期（剩余 ${daysRemaining} 天）`);
            }
            const isSelfSigned = certInfo.subject === certInfo.issuer ||
                certInfo.issuer.includes('self-signed') ||
                certInfo.issuer.includes('Fake');
            if (isSelfSigned && !this.config.allowSelfSigned) {
                errors.push('自签名证书（可能存在中间人攻击）');
            }
            const result = {
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
        }
        catch (err) {
            const message = err.message;
            errors.push(`SSL验证失败: ${message}`);
            this.logViolation(hostname, errors);
            return { valid: false, hostname, errors, warnings };
        }
    }
    install() {
        if (!this.config.enabled) {
            Logger_1.Logger.info('⚠️ SSL守卫：已禁用', 'SslGuard');
            return;
        }
        const originalCreateSecureContext = tls.createSecureContext;
        const guard = this;
        tls.createSecureContext = function patchedCreateSecureContext(options) {
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
                            Logger_1.Logger.warn('🚫 SSL守卫：拦截自签名证书', 'SslGuard');
                        }
                    }
                }
                catch (err) {
                    Logger_1.Logger.debug(`SSL证书解析失败（非阻塞）: ${err?.message}`, 'SslGuard');
                }
            }
            return context;
        };
        Logger_1.Logger.info('✅ SSL守卫：证书验证已安装', 'SslGuard');
    }
    getViolationLog() {
        return [...this.violationLog];
    }
    updateConfig(config) {
        Object.assign(this.config, config);
        Logger_1.Logger.info('🔧 SSL守卫：配置已更新', 'SslGuard');
    }
    fetchCertificate(hostname, port) {
        return new Promise((resolve) => {
            const req = https.request({
                hostname,
                port,
                method: 'HEAD',
                path: '/',
                rejectUnauthorized: false,
                timeout: 10000,
            }, (res) => {
                const socket = res.socket;
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
            });
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
    logViolation(hostname, errors) {
        this.violationLog.push({
            hostname,
            timestamp: Date.now(),
            errors,
        });
        if (this.violationLog.length > 100) {
            this.violationLog = this.violationLog.slice(-50);
        }
        Logger_1.Logger.warn(`🚫 SSL守卫：${hostname} - ${errors.join(', ')}`, 'SslGuard');
    }
}
exports.SslGuard = SslGuard;
SslGuard.instance = null;
exports.sslGuard = SslGuard.getInstance();
