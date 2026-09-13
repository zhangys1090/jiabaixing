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
exports.getIpcPath = getIpcPath;
exports.extractResponse = extractResponse;
exports.requestWithFallback = requestWithFallback;
exports.ipcSend = ipcSend;
exports.isIpcAvailable = isIpcAvailable;
const net = __importStar(require("net"));
const Logger_1 = require("../utils/Logger");
const constants_1 = require("./constants");
/**
 * 获取 IPC 端点路径
 * Windows 使用 Named Pipe，Linux/macOS 使用 Unix Domain Socket
 * 可通过环境变量 IPC_PATH 覆盖默认路径
 * @returns IPC 端点路径
 */
function getIpcPath() {
    if (process.env.IPC_PATH) {
        return process.env.IPC_PATH;
    }
    const isWindows = process.platform === 'win32';
    return isWindows ? '\\\\.\\pipe\\jiabaixing' : '/tmp/jiabaixing.sock';
}
/**
 * 从响应数据中提取文本内容，兼容多种响应格式
 * 支持嵌套 data.data.response、data.response、data.message、data.text 等
 * @param data - 响应数据（对象或任意类型）
 * @returns 提取的文本内容
 */
function extractResponse(data) {
    if (typeof data === 'string')
        return data;
    if (data == null)
        return '';
    const obj = data;
    return (obj.data?.response ??
        obj.response ??
        obj.message ??
        obj.text ??
        obj.output ??
        obj.error ??
        JSON.stringify(data));
}
/**
 * 通用请求函数：优先尝试 IPC，失败时降级到 HTTP
 * @param ipcMethod - IPC 方法名
 * @param ipcParams - IPC 参数
 * @param httpOptions - HTTP 选项
 * @returns 请求结果
 */
async function requestWithFallback(ipcMethod, ipcParams = {}, httpOptions) {
    // 优先尝试 IPC
    try {
        const ipcResult = await ipcSend(ipcMethod, ipcParams);
        return ipcResult;
    }
    catch (err) {
        Logger_1.Logger.warn(`IPC 请求 "${ipcMethod}" 失败，降级到 HTTP`, 'RequestWithFallback', err);
    }
    // HTTP 请求
    const { path, method = 'GET', body, timeout = 60000 } = httpOptions;
    const res = await fetch(`${constants_1.backendUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
    });
    return (await res.json());
}
/**
 * 通过 IPC 发送请求到 jiabaixing 服务端
 * 使用 JSON Lines 协议通信，比 HTTP 更快（无 HTTP 开销）
 * @param method - 要调用的方法名
 * @param params - 方法参数
 * @returns 服务端返回的 result 字段，或抛出错误
 */
async function ipcSend(method, params = {}) {
    const ipcPath = getIpcPath();
    let requestId = 0;
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(ipcPath, () => {
            requestId++;
            const request = JSON.stringify({ id: requestId, method, params }) + '\n';
            socket.write(request);
        });
        let buffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('IPC 连接超时'));
        }, constants_1.IPC_TIMEOUT_MS);
        socket.on('data', (data) => {
            buffer += data.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed)
                    continue;
                clearTimeout(timer);
                try {
                    const response = JSON.parse(trimmed);
                    if (response.error) {
                        socket.destroy();
                        reject(new Error(response.error.message));
                    }
                    else {
                        socket.destroy();
                        resolve(response.result);
                    }
                }
                catch (err) {
                    Logger_1.Logger.debug('IPC 响应部分解析失败，继续等待完整数据', 'IpcSend', err);
                }
            }
        });
        socket.on('error', () => {
            clearTimeout(timer);
            reject(new Error('IPC 连接不可用'));
        });
        socket.on('close', () => {
            clearTimeout(timer);
        });
    });
}
/**
 * 检测 IPC 服务是否可用
 * 通过发送 ping 请求验证连接
 * @returns true 表示 IPC 可用
 */
async function isIpcAvailable() {
    try {
        await ipcSend('ping');
        return true;
    }
    catch {
        return false;
    }
}
