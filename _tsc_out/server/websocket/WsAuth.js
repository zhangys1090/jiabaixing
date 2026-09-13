"use strict";
/**
 * WebSocket 认证模块
 * 从 websocket.ts 提取，专门处理认证逻辑
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsAuthenticator = void 0;
exports.createAuthErrorResponse = createAuthErrorResponse;
const AuthenticationManager_1 = require("../../security/AuthenticationManager");
const Logger_1 = require("../../utils/Logger");
/**
 * WebSocket 认证器
 */
class WsAuthenticator {
    authManager = null;
    initialized = false;
    /**
     * 初始化认证管理器
     */
    ensureAuthManager() {
        if (!this.initialized) {
            this.initialized = true;
            try {
                this.authManager = new AuthenticationManager_1.AuthenticationManager();
            }
            catch {
                Logger_1.Logger.warn('⚠️ 认证模块未初始化，WebSocket跳过认证', 'WsAuth');
            }
        }
        return this.authManager;
    }
    /**
     * 验证 WebSocket 认证令牌（生产环境）
     * @param token - 认证令牌
     * @returns 认证结果
     */
    verifyToken(token) {
        if (process.env.NODE_ENV === 'production') {
            if (!token) {
                return { valid: false, error: '认证失败：缺少令牌' };
            }
            const authManager = this.ensureAuthManager();
            if (!authManager) {
                Logger_1.Logger.error('🚫 认证模块未初始化，fail-closed 拒绝连接', undefined, 'WsAuth');
                return { valid: false, error: '认证服务不可用' };
            }
            try {
                const result = authManager.verifyToken(token);
                if (!result.valid) {
                    return { valid: false, error: `认证失败：${result.error}` };
                }
                return { valid: true };
            }
            catch (err) {
                Logger_1.Logger.error('🚫 认证验证异常，fail-closed 拒绝连接', err, 'WsAuth');
                return { valid: false, error: '认证服务异常' };
            }
        }
        if (process.env.NODE_ENV !== 'development' &&
            process.env.NODE_ENV !== 'test') {
            Logger_1.Logger.warn('⚠️ NODE_ENV 未设置，WebSocket 认证已跳过，建议设置 NODE_ENV=production', 'WsAuth');
        }
        return { valid: true };
    }
    /**
     * 从 URL 参数提取令牌
     */
    extractTokenFromUrl(urlStr) {
        try {
            const url = new URL(urlStr, 'http://localhost');
            return url.searchParams.get('token');
        }
        catch {
            return null;
        }
    }
}
exports.WsAuthenticator = WsAuthenticator;
/**
 * 创建认证失败响应
 */
function createAuthErrorResponse(error, code = 4001) {
    return {
        type: 'error',
        data: { message: error },
        _wsCloseCode: code,
    };
}
