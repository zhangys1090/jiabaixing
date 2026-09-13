"use strict";
/**
 * 认证管理器 - 处理用户认证和授权
 */
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthenticationManager = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const fs = __importStar(require("fs"));
const jwt = __importStar(require("jsonwebtoken"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
/**
 * 默认认证配置
 * 注意：JWT secret 必须通过环境变量配置，禁止硬编码
 */
const DEFAULT_AUTH_CONFIG = {
    password: {
        minLength: 8,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSpecialChar: true,
        saltRounds: 10,
        maxAttempts: 5,
        lockoutDuration: 300, // 5分钟
    },
    voiceprint: {
        enabled: false,
        threshold: 0.8,
    },
    jwt: {
        secret: '', // 必须在初始化时从环境变量设置
        expiresIn: '24h',
        refreshExpiresIn: '7d',
    },
};
/**
 * 认证管理器类
 */
class AuthenticationManager {
    config;
    userStorage = {};
    initialized = false;
    auditLogger;
    // P0-6 修复: 用户数据持久化路径
    userStoragePath;
    _saveTimer;
    constructor(config = {}) {
        this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
        this.userStoragePath = path.join(process.cwd(), 'data', 'auth', 'users.json');
    }
    /**
     * 设置审计日志器
     */
    setAuditLogger(auditLogger) {
        this.auditLogger = auditLogger;
    }
    /**
     * 初始化认证管理器
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        try {
            // JWT secret 必须从环境变量获取，禁止使用空值
            const envJwtSecret = process.env.JWT_SECRET;
            if (!envJwtSecret) {
                throw new Error('JWT_SECRET 环境变量未配置，拒绝启动认证服务');
            }
            this.config.jwt.secret = envJwtSecret;
            this.initializeUserStorage();
            // P0-6 修复: 从磁盘加载持久化的用户数据
            this.loadUserStorageFromDisk();
            // P0-6: 定期将用户数据持久化到磁盘（每 30 秒）
            this._saveTimer = setInterval(() => {
                this.saveUserStorageToDisk();
            }, 30_000).unref();
            this.initialized = true;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 认证管理器：初始化失败:', error);
            throw error;
        }
    }
    /**
     * 初始化用户存储（临时实现）
     */
    initializeUserStorage() {
        if (process.env.NODE_ENV === 'production') {
            this.userStorage = {};
            Logger_1.Logger.info('🔒 生产环境：不创建默认用户，请通过注册流程创建');
            return;
        }
        const devPassword = process.env.DEV_DEFAULT_PASSWORD;
        if (!devPassword) {
            this.userStorage = {};
            Logger_1.Logger.warn('⚠️ 开发环境：DEV_DEFAULT_PASSWORD 未设置，不创建默认用户。请设置环境变量后重启。');
            return;
        }
        const strengthCheck = this.validatePasswordStrength(devPassword);
        if (!strengthCheck.valid) {
            this.userStorage = {};
            Logger_1.Logger.error(`❌ DEV_DEFAULT_PASSWORD 不满足强度要求: ${strengthCheck.errors.join('; ')}`);
            return;
        }
        const defaultPasswordHash = bcrypt_1.default.hashSync(devPassword, this.config.password.saltRounds || 10);
        this.userStorage = {
            admin: {
                passwordHash: defaultPasswordHash,
                userId: 'admin-001',
                email: 'admin@example.com',
                failedAttempts: 0,
                roles: ['admin', 'user'],
            },
            user: {
                passwordHash: defaultPasswordHash,
                userId: 'user-001',
                email: 'user@example.com',
                failedAttempts: 0,
                roles: ['user'],
            },
        };
        Logger_1.Logger.warn('⚠️ 开发环境：已从 DEV_DEFAULT_PASSWORD 创建默认用户(admin/user)，生产环境将禁用');
    }
    /**
     * 验证密码强度
     */
    validatePasswordStrength(password) {
        const errors = [];
        if (password.length < this.config.password.minLength) {
            errors.push(`密码长度必须至少为 ${this.config.password.minLength} 个字符`);
        }
        if (this.config.password.requireUppercase && !/[A-Z]/.test(password)) {
            errors.push('密码必须包含至少一个大写字母');
        }
        if (this.config.password.requireLowercase && !/[a-z]/.test(password)) {
            errors.push('密码必须包含至少一个小写字母');
        }
        if (this.config.password.requireNumber && !/\d/.test(password)) {
            errors.push('密码必须包含至少一个数字');
        }
        if (this.config.password.requireSpecialChar &&
            !/[^A-Za-z0-9]/.test(password)) {
            errors.push('密码必须包含至少一个特殊字符');
        }
        return { valid: errors.length === 0, errors };
    }
    /**
     * 检查用户是否被锁定
     */
    isUserLocked(username) {
        const user = this.userStorage[username];
        if (!user)
            return false;
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            return true;
        }
        // 解锁用户
        if (user.lockedUntil && user.lockedUntil <= new Date()) {
            user.lockedUntil = undefined;
            user.failedAttempts = 0;
        }
        return false;
    }
    /**
     * 处理登录失败
     */
    handleLoginFailure(username) {
        const user = this.userStorage[username];
        if (!user)
            return;
        user.failedAttempts++;
        user.lastFailedAttempt = new Date();
        // 检查是否需要锁定用户
        if (user.failedAttempts >= this.config.password.maxAttempts) {
            user.lockedUntil = new Date(Date.now() + this.config.password.lockoutDuration * 1000);
            Logger_1.Logger.warn(`🔒 用户 ${username} 已被锁定，锁定时间：${user.lockedUntil}`);
        }
    }
    /**
     * 验证声纹（临时实现，后续应集成实际的声纹识别库）
     */
    async verifyVoiceprint(voiceprintData, storedVoiceprintData) {
        // 临时实现：简单比较声纹数据
        // 实际实现应使用专业的声纹识别算法
        if (!storedVoiceprintData)
            return false;
        // 模拟声纹匹配，实际应使用相似度算法
        return voiceprintData === storedVoiceprintData;
    }
    /**
     * 用户认证
     */
    async authenticate(request) {
        try {
            const { username, password, voiceprintData, deviceId } = request;
            // 检查用户是否存在
            const user = this.userStorage[username];
            if (!user) {
                this.logAudit(undefined, 'authentication.failure', {
                    username,
                    reason: '用户不存在',
                    deviceId,
                });
                return { success: false, error: '用户名或密码错误' };
            }
            // 检查用户是否被锁定
            if (this.isUserLocked(username)) {
                this.logAudit(user.userId, 'authentication.failure', {
                    username,
                    reason: '用户已被锁定',
                    deviceId,
                });
                return { success: false, error: '账户已被锁定，请稍后再试' };
            }
            let authenticated = false;
            // 密码认证
            if (password) {
                authenticated = await bcrypt_1.default.compare(password, user.passwordHash);
            }
            // 声纹认证（如果启用且提供了声纹数据）
            if (!authenticated && this.config.voiceprint.enabled && voiceprintData) {
                authenticated = await this.verifyVoiceprint(voiceprintData, user.voiceprintData);
            }
            if (!authenticated) {
                // 处理登录失败
                this.handleLoginFailure(username);
                this.logAudit(user.userId, 'authentication.failure', {
                    username,
                    reason: '认证失败',
                    deviceId,
                });
                return { success: false, error: '用户名或密码错误' };
            }
            // 认证成功，重置失败尝试次数
            user.failedAttempts = 0;
            user.lastFailedAttempt = undefined;
            // 生成JWT令牌
            const token = jwt.sign({ userId: user.userId, username, roles: user.roles }, this.config.jwt.secret, { expiresIn: this.config.jwt.expiresIn });
            const refreshToken = jwt.sign({ userId: user.userId, username }, this.config.jwt.secret, { expiresIn: this.config.jwt.refreshExpiresIn });
            // 构建用户认证信息
            const userAuthInfo = {
                userId: user.userId,
                username,
                email: user.email,
                phone: user.phone,
                isAuthenticated: true,
                lastLogin: new Date(),
                roles: user.roles,
            };
            // 记录审计日志
            this.logAudit(user.userId, 'authentication.success', {
                username,
                deviceId,
                userId: user.userId,
            });
            return {
                success: true,
                token,
                refreshToken,
                user: userAuthInfo,
            };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 认证失败:', error);
            this.logAudit(undefined, 'authentication.failure', {
                username: request.username,
                reason: '系统错误',
                error: error.message,
            });
            return { success: false, error: '认证过程中发生错误，请稍后再试' };
        }
    }
    /**
     * 验证令牌
     */
    verifyToken(token) {
        try {
            const payload = jwt.verify(token, this.config.jwt.secret);
            return { valid: true, payload };
        }
        catch (error) {
            return { valid: false, error: error.message };
        }
    }
    /**
     * 刷新令牌
     */
    refreshToken(refreshToken) {
        try {
            const payload = jwt.verify(refreshToken, this.config.jwt.secret);
            // 检查用户是否存在
            const user = this.userStorage[payload.username];
            if (!user) {
                return { success: false, error: '用户不存在' };
            }
            // 生成新的访问令牌
            const newToken = jwt.sign({
                userId: user.userId,
                username: payload.username,
                roles: user.roles,
            }, this.config.jwt.secret, { expiresIn: this.config.jwt.expiresIn });
            return { success: true, token: newToken };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
    /**
     * 注册新用户
     */
    async register(username, password, email, phone) {
        try {
            // 检查用户是否已存在
            if (this.userStorage[username]) {
                return { success: false, error: '用户名已存在' };
            }
            // 验证密码强度
            const passwordValidation = this.validatePasswordStrength(password);
            if (!passwordValidation.valid) {
                return { success: false, error: passwordValidation.errors.join('; ') };
            }
            // 哈希密码
            const passwordHash = await bcrypt_1.default.hash(password, this.config.password.saltRounds || 10);
            // 创建新用户
            const newUser = {
                passwordHash,
                userId: `user-${Date.now()}`,
                email,
                phone,
                failedAttempts: 0,
                roles: ['user'],
            };
            // 保存到用户存储
            this.userStorage[username] = newUser;
            // 记录审计日志
            this.logAudit(newUser.userId, 'authentication.success', {
                username,
                reason: '用户注册成功',
            });
            return { success: true };
        }
        catch (error) {
            Logger_1.Logger.error('❌ 用户注册失败:', error);
            this.logAudit(undefined, 'authentication.failure', {
                username,
                reason: '用户注册失败',
                error: error.message,
            });
            return { success: false, error: '注册过程中发生错误，请稍后再试' };
        }
    }
    /**
     * P0-6 修复: 从磁盘加载持久化的用户数据
     * 合并策略：磁盘数据优先，内存中不存在的用户从磁盘补充
     */
    loadUserStorageFromDisk() {
        try {
            if (!fs.existsSync(this.userStoragePath)) {
                Logger_1.Logger.info('📁 用户存储文件不存在，将从内存初始化', 'AuthManager');
                return;
            }
            const raw = fs.readFileSync(this.userStoragePath, 'utf8');
            const persisted = JSON.parse(raw);
            // 合并：磁盘数据补充内存中不存在的用户
            for (const [username, userData] of Object.entries(persisted)) {
                if (!this.userStorage[username]) {
                    this.userStorage[username] = userData;
                }
            }
            Logger_1.Logger.info(`💾 已从磁盘加载 ${Object.keys(persisted).length} 个用户`, 'AuthManager');
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 加载用户存储失败（使用内存数据）: ${err.message}`, 'AuthManager');
        }
    }
    /**
     * P0-6 修复: 将用户数据持久化到磁盘
     */
    saveUserStorageToDisk() {
        try {
            const dir = path.dirname(this.userStoragePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.userStoragePath, JSON.stringify(this.userStorage, null, 2), { mode: 0o600 });
        }
        catch (err) {
            Logger_1.Logger.warn(`⚠️ 保存用户存储失败: ${err.message}`, 'AuthManager');
        }
    }
    /**
     * 记录审计日志
     */
    logAudit(userId, action, details) {
        if (this.auditLogger) {
            this.auditLogger.log({
                userId: userId || 'unknown',
                action,
                resource: 'authentication',
                result: action.includes('success') ? 'success' : 'failure',
                details,
            });
        }
    }
    /**
     * 关闭认证管理器
     */
    async shutdown() {
        if (!this.initialized) {
            return;
        }
        Logger_1.Logger.info('🔑 认证管理器：关闭中...');
        // 清理资源
        this.userStorage = {};
        this.initialized = false;
        Logger_1.Logger.info('✅ 认证管理器：关闭完成！');
    }
}
exports.AuthenticationManager = AuthenticationManager;
