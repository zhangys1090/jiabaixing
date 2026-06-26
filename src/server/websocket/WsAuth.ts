/**
 * WebSocket 认证模块
 * 从 websocket.ts 提取，专门处理认证逻辑
 */

import { Logger } from '../../utils/Logger';
import { AuthenticationManager } from '../../security/AuthenticationManager';

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
    // 生产环境必须验证
    if (process.env.NODE_ENV === 'production') {
      if (!token) {
        return { valid: false, error: '认证失败：缺少令牌' };
      }

      const authManager = this.ensureAuthManager();
      if (!authManager) {
        Logger.warn('⚠️ 认证模块未初始化，WebSocket跳过认证', 'WsAuth');
        return { valid: true }; // 降级：允许连接
      }

      try {
        const result = authManager.verifyToken(token);
        if (!result.valid) {
          return { valid: false, error: `认证失败：${result.error}` };
        }
        return { valid: true };
      } catch {
        Logger.warn('⚠️ 认证验证异常，跳过认证', 'WsAuth');
        return { valid: true }; // 降级：允许连接
      }
    }

    // 非生产环境跳过认证
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
