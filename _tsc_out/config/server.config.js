"use strict";
/**
 * 服务器配置模块
 * 处理端口配置、验证和可用性检查
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidPort = isValidPort;
exports.initializeServerConfig = initializeServerConfig;
const child_process_1 = require("child_process");
const net = __importStar(require("net"));
const Logger_1 = require("../utils/Logger");
/**
 * 检查端口是否可用
 * @param port 端口号
 * @returns Promise<boolean> 端口是否可用
 */
async function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => {
            resolve(false);
        });
        server.once('listening', () => {
            server.close(() => {
                resolve(true);
            });
        });
        server.listen(port);
    });
}
/**
 * 尝试释放占用的端口
 * @param port 端口号
 * @returns Promise<boolean> 是否成功释放
 */
async function tryReleasePort(port) {
    try {
        const netstatOutput = await new Promise((resolve) => {
            (0, child_process_1.exec)(`netstat -ano | findstr :${port}`, (error, stdout) => {
                if (error)
                    resolve('');
                else
                    resolve(stdout);
            });
        });
        const lines = netstatOutput.split('\n');
        for (const line of lines) {
            const match = line.match(/\s+(\d+)\s*$/);
            if (match) {
                const pid = match[1];
                if (!/^\d+$/.test(pid)) {
                    Logger_1.Logger.warn(`⚠️ 无效的PID格式，跳过: ${pid}`);
                    continue;
                }
                await new Promise((resolve) => {
                    const safePid = parseInt(pid, 10);
                    if (!Number.isFinite(safePid) || safePid <= 0) {
                        Logger_1.Logger.warn(`⚠️ PID超出有效范围，跳过: ${pid}`);
                        resolve();
                        return;
                    }
                    (0, child_process_1.exec)(`taskkill /F /PID ${safePid}`, (error) => {
                        if (error) {
                            Logger_1.Logger.warn(`⚠️ 无法终止进程 ${pid}：${error.message}`);
                            resolve();
                        }
                        else {
                            Logger_1.Logger.info(`✅ 已终止占用端口 ${port} 的进程 ${pid}`);
                            resolve();
                        }
                    });
                });
                return true;
            }
        }
        return false;
    }
    catch (error) {
        Logger_1.Logger.warn(`ℹ️ 尝试释放端口 ${port} 失败：${error.message}`);
        return false;
    }
}
/**
 * 寻找可用端口并尝试释放占用的端口
 * @param startPort 起始端口
 * @param maxAttempts 最大尝试次数
 * @returns Promise<number> 可用端口号
 */
async function findAvailablePort(startPort, maxAttempts = 10) {
    Logger_1.Logger.info(`🔍 开始寻找可用端口，从 ${startPort} 开始，最多尝试 ${maxAttempts} 次`);
    for (let i = 0; i < maxAttempts; i++) {
        const port = startPort + i;
        Logger_1.Logger.info(`🔍 检查端口 ${port} 是否可用...`);
        if (await isPortAvailable(port)) {
            Logger_1.Logger.info(`✅ 端口 ${port} 可用`);
            return port;
        }
        else {
            Logger_1.Logger.warn(`⚠️ 端口 ${port} 已被占用，尝试释放...`);
            const released = await tryReleasePort(port);
            if (released) {
                await new Promise((resolve) => setTimeout(resolve, 500));
                if (await isPortAvailable(port)) {
                    Logger_1.Logger.info(`✅ 端口 ${port} 已释放并可用`);
                    return port;
                }
                else {
                    Logger_1.Logger.warn(`⚠️ 端口 ${port} 释放后仍然不可用`);
                }
            }
            else {
                Logger_1.Logger.warn(`⚠️ 端口 ${port} 无法释放，尝试下一个端口...`);
            }
        }
    }
    const errorMessage = `无法在端口范围 ${startPort}-${startPort + maxAttempts - 1} 内找到可用端口`;
    Logger_1.Logger.error(`❌ ${errorMessage}`);
    throw new Error(errorMessage);
}
/**
 * 验证端口是否在有效范围内
 * @param port 端口号
 * @returns boolean 端口是否有效
 */
function isValidPort(port) {
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
}
/**
 * 初始化服务器配置
 * @returns Promise<ServerConfig> 服务器配置
 */
async function initializeServerConfig() {
    const defaultConfig = {
        port: 3111,
        host: '0.0.0.0',
        maxRetryAttempts: 10,
    };
    try {
        let port = parseInt(process.env.PORT || '3111', 10);
        if (!isValidPort(port)) {
            Logger_1.Logger.warn(`⚠️ 无效的端口配置: ${port}，使用默认端口 ${defaultConfig.port}`);
            port = defaultConfig.port;
        }
        port = await findAvailablePort(port, defaultConfig.maxRetryAttempts);
        Logger_1.Logger.info(`✅ 服务器配置初始化完成，使用端口 ${port}`);
        return {
            ...defaultConfig,
            port,
        };
    }
    catch (error) {
        Logger_1.Logger.error('❌ 服务器配置初始化失败:', error);
        Logger_1.Logger.warn(`⚠️ 使用默认端口 ${defaultConfig.port}`);
        return defaultConfig;
    }
}
