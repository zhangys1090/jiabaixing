"use strict";
/**
 * 统一文件系统 IO 抽象层
 * 提供异步文件操作、缓存、批量写入能力
 * 所有模块的文件操作应通过此层进行
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
exports.FileSystem = void 0;
const fs_1 = __importDefault(require("fs"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
class FileSystem {
    constructor() {
        this.cache = new Map();
        this.MAX_CACHE_ENTRIES = 5000;
        this.writeQueue = new Map();
        this.MAX_WRITE_QUEUE = 1000;
        this.defaultCacheTtl = 30000; // 30秒
    }
    static getInstance() {
        if (!FileSystem.instance) {
            FileSystem.instance = new FileSystem();
        }
        return FileSystem.instance;
    }
    /**
     * 异步读取文件（带缓存）
     */
    async readFile(filePath, options = {}) {
        const { encoding = 'utf-8', cache = false, cacheTtlMs } = options;
        const absolutePath = path.resolve(filePath);
        // 检查缓存
        if (cache) {
            const cached = this.cache.get(absolutePath);
            if (cached && Date.now() - cached.timestamp < cached.ttlMs) {
                return cached.content;
            }
        }
        try {
            const content = await fs.readFile(absolutePath, { encoding });
            if (cache) {
                if (this.cache.size >= this.MAX_CACHE_ENTRIES && !this.cache.has(absolutePath)) {
                    const oldestKey = this.cache.keys().next().value;
                    this.cache.delete(oldestKey);
                }
                this.cache.set(absolutePath, {
                    content,
                    timestamp: Date.now(),
                    ttlMs: cacheTtlMs || this.defaultCacheTtl,
                });
            }
            return content;
        }
        catch (error) {
            throw new Error(`读取文件失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 异步读取二进制文件
     */
    async readFileBuffer(filePath) {
        const absolutePath = path.resolve(filePath);
        try {
            return await fs.readFile(absolutePath);
        }
        catch (error) {
            throw new Error(`读取文件失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 异步写入文件（支持原子写入）
     */
    async writeFile(filePath, content, options = {}) {
        const { encoding = 'utf-8', mode, atomic = true } = options;
        const absolutePath = path.resolve(filePath);
        // 确保目录存在
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        if (atomic) {
            // 原子写入：先写入临时文件，再重命名
            const tempPath = `${absolutePath}.tmp`;
            await fs.writeFile(tempPath, content, { encoding, mode });
            await fs.rename(tempPath, absolutePath);
        }
        else {
            await fs.writeFile(absolutePath, content, { encoding, mode });
        }
        // 清除缓存
        this.cache.delete(absolutePath);
    }
    /**
     * 异步追加写入
     */
    async appendFile(filePath, content, options = {}) {
        const { encoding = 'utf-8' } = options;
        const absolutePath = path.resolve(filePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.appendFile(absolutePath, content, { encoding });
        // 清除缓存
        this.cache.delete(absolutePath);
    }
    /**
     * 检查文件是否存在
     */
    async exists(filePath) {
        try {
            await fs.access(path.resolve(filePath));
            return true;
        }
        catch (err) {
            return false;
        }
    }
    /**
     * 读取 JSON 文件
     */
    async readJson(filePath, options) {
        const content = await this.readFile(filePath, options);
        return JSON.parse(content);
    }
    /**
     * 写入 JSON 文件
     */
    async writeJson(filePath, data, options) {
        const content = JSON.stringify(data, null, 2);
        await this.writeFile(filePath, content, options);
    }
    /**
     * 批量读取文件
     */
    async readFiles(filePaths, options) {
        const results = new Map();
        const errors = [];
        await Promise.all(filePaths.map(async (fp) => {
            try {
                const content = await this.readFile(fp, options);
                results.set(fp, content);
            }
            catch (error) {
                errors.push(`${fp}: ${error.message}`);
            }
        }));
        if (errors.length > 0) {
            Logger_1.Logger.warn(`批量读取中有 ${errors.length} 个文件失败`, 'FileSystem');
        }
        return results;
    }
    /**
     * 批量写入文件（串行，避免磁盘争用）
     */
    async writeFiles(files) {
        for (const file of files) {
            await this.writeFile(file.path, file.content, file.options);
        }
    }
    /**
     * 清除缓存
     */
    clearCache(filePath) {
        if (filePath) {
            this.cache.delete(path.resolve(filePath));
        }
        else {
            this.cache.clear();
        }
    }
    /**
     * 读取目录
     */
    async readDir(dirPath) {
        const absolutePath = path.resolve(dirPath);
        try {
            return await fs.readdir(absolutePath);
        }
        catch (error) {
            throw new Error(`读取目录失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 获取文件状态
     */
    async stat(filePath) {
        const absolutePath = path.resolve(filePath);
        try {
            const stats = await fs.stat(absolutePath);
            return {
                size: stats.size,
                mtime: stats.mtime,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory(),
            };
        }
        catch (error) {
            throw new Error(`获取文件状态失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 重命名文件
     */
    async rename(oldPath, newPath) {
        const absoluteOldPath = path.resolve(oldPath);
        const absoluteNewPath = path.resolve(newPath);
        try {
            await fs.rename(absoluteOldPath, absoluteNewPath);
        }
        catch (error) {
            throw new Error(`重命名文件失败 ${absoluteOldPath} -> ${absoluteNewPath}: ${error.message}`);
        }
    }
    /**
     * 删除文件
     */
    async unlink(filePath) {
        const absolutePath = path.resolve(filePath);
        try {
            await fs.unlink(absolutePath);
            this.cache.delete(absolutePath);
        }
        catch (error) {
            throw new Error(`删除文件失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 删除文件（别名）
     */
    async deleteFile(filePath) {
        return this.unlink(filePath);
    }
    /**
     * 确保目录存在（递归创建）
     */
    async ensureDir(dirPath) {
        const absolutePath = path.resolve(dirPath);
        try {
            await fs.mkdir(absolutePath, { recursive: true });
        }
        catch (error) {
            throw new Error(`创建目录失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 获取文件信息
     */
    async getFileInfo(filePath) {
        return this.stat(filePath);
    }
    /**
     * 同步读取文件（用于解析场景）
     */
    readFileSync(filePath, encoding = 'utf-8') {
        const absolutePath = path.resolve(filePath);
        try {
            return fs_1.default.readFileSync(absolutePath, { encoding });
        }
        catch (error) {
            throw new Error(`同步读取文件失败 ${absolutePath}: ${error.message}`);
        }
    }
    /**
     * 获取缓存统计
     */
    getCacheStats() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys()),
        };
    }
}
exports.FileSystem = FileSystem;
// 便捷导出
