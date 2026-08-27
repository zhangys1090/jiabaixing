/**
 * WebSocket 认证模块
 * 从 websocket.ts 提取，专门处理认证逻辑
 */

import { AuthenticationManager } from '../../security/AuthenticationManager';
import { Logger } from '../../utils/Logger';

/**
 * 认证结果
 */
export interface AuthResult {
  valid: boolean;
  error?: string;
}

/**
 * WebSocket 认证器
 */
export class WsAuthenticator {
  private authManager: AuthenticationManager | null = null;
  private initialized = false;

  /**
   * 初始化认证管理器
   */
  private ensureAuthManager(): AuthenticationManager | null {
    if (!this.initialized) {
      this.initialized = true;
      try {
        this.authManager = new AuthenticationManager();
      } catch {
        Logger.warn('⚠️ 认证模块未初始化，WebSocket跳过认证', 'WsAuth');
      }
    }
    return this.authManager;
  }

  /**
   * 验证 WebSocket 认证令牌（生产环境）
   * @param token - 认证令牌
   * @returns 认证结果
   */
  verifyToken(token: string | null): AuthResult {
    if (process.env.NODE_ENV === 'production') {
      if (!token) {
        return { valid: false, error: '认证失败：缺少令牌' };
      }

      const authManager = this.ensureAuthManager();
      if (!authManager) {
        Logger.error(
          '🚫 认证模块未初始化，fail-closed 拒绝连接',
          undefined,
          'WsAuth'
        );
        return { valid: false, error: '认证服务不可用' };
      }

      try {
        const result = authManager.verifyToken(token);
        if (!result.valid) {
          return { valid: false, error: `认证失败：${result.error}` };
        }
        return { valid: true };
      } catch (err) {
        Logger.error(
          '🚫 认证验证异常，fail-closed 拒绝连接',
          err as Error,
          'WsAuth'
        );
        return { valid: false, error: '认证服务异常' };
      }
    }

    if (
      process.env.NODE_ENV !== 'development' &&
      process.env.NODE_ENV !== 'test'
    ) {
      Logger.warn(
        '⚠️ NODE_ENV 未设置，WebSocket 认证已跳过，建议设置 NODE_ENV=production',
        'WsAuth'
      );
    }
    return { valid: true };
  }

  /**
   * 从 URL 参数提取令牌
   */
  extractTokenFromUrl(urlStr: string): string | null {
    try {
      const url = new URL(urlStr, 'http://localhost');
      return url.searchParams.get('token');
    } catch {
      return null;
    }
  }
}

/**
 * 创建认证失败响应
 */
export function createAuthErrorResponse(
  error: string,
  code: number = 4001
): object {
  return {
    type: 'error',
    data: { message: error },
    _wsCloseCode: code,
  };
}
