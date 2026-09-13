"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileSyncService = void 0;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Logger_1 = require("../../../utils/Logger");
class FileSyncService {
    config;
    syncHistory = [];
    constructor(config) {
        this.config = {
            port: 22,
            localBasePath: process.cwd(),
            remoteBasePath: '/workspace',
            excludePatterns: [
                'node_modules',
                '.git',
                '__pycache__',
                '*.pyc',
                '.env',
                'dist',
                'build',
                '.next',
            ],
            ...config,
        };
    }
    async push(localPath, remotePath) {
        const startTime = Date.now();
        const errors = [];
        let filesSynced = 0;
        let bytesTransferred = 0;
        const src = localPath || this.config.localBasePath;
        const dst = this.buildRemotePath(remotePath || this.config.remoteBasePath);
        try {
            const rsyncCmd = this.buildRsyncCommand(src, dst, 'push');
            const result = await this.execAsync(rsyncCmd, 120000);
            if (result.exitCode !== 0) {
                errors.push(`rsync push 失败: ${result.stderr}`);
            }
            else {
                const stats = this.parseRsyncStats(result.stdout);
                filesSynced = stats.files;
                bytesTransferred = stats.bytes;
            }
        }
        catch (err) {
            errors.push(`push 异常: ${err.message}`);
        }
        const syncResult = {
            success: errors.length === 0,
            filesSynced,
            bytesTransferred,
            durationMs: Date.now() - startTime,
            errors,
        };
        this.recordHistory('push', syncResult);
        return syncResult;
    }
    async pull(remotePath, localPath) {
        const startTime = Date.now();
        const errors = [];
        let filesSynced = 0;
        let bytesTransferred = 0;
        const src = this.buildRemotePath(remotePath || this.config.remoteBasePath);
        const dst = localPath || this.config.localBasePath;
        try {
            const rsyncCmd = this.buildRsyncCommand(src, dst, 'pull');
            const result = await this.execAsync(rsyncCmd, 120000);
            if (result.exitCode !== 0) {
                errors.push(`rsync pull 失败: ${result.stderr}`);
            }
            else {
                const stats = this.parseRsyncStats(result.stdout);
                filesSynced = stats.files;
                bytesTransferred = stats.bytes;
            }
        }
        catch (err) {
            errors.push(`pull 异常: ${err.message}`);
        }
        const syncResult = {
            success: errors.length === 0,
            filesSynced,
            bytesTransferred,
            durationMs: Date.now() - startTime,
            errors,
        };
        this.recordHistory('pull', syncResult);
        return syncResult;
    }
    async syncBidirectional() {
        const pushResult = await this.push();
        const pullResult = await this.pull();
        return { pushResult, pullResult };
    }
    async pushFile(localFilePath, remoteFilePath) {
        const startTime = Date.now();
        if (!fs_1.default.existsSync(localFilePath)) {
            return {
                success: false,
                filesSynced: 0,
                bytesTransferred: 0,
                durationMs: 0,
                errors: [`本地文件不存在: ${localFilePath}`],
            };
        }
        const remoteTarget = this.buildRemotePath(remoteFilePath);
        const rsyncCmd = this.buildRsyncCommand(localFilePath, remoteTarget, 'push');
        try {
            const result = await this.execAsync(rsyncCmd, 60000);
            const stat = fs_1.default.statSync(localFilePath);
            return {
                success: result.exitCode === 0,
                filesSynced: result.exitCode === 0 ? 1 : 0,
                bytesTransferred: stat.size,
                durationMs: Date.now() - startTime,
                errors: result.exitCode !== 0 ? [result.stderr] : [],
            };
        }
        catch (err) {
            return {
                success: false,
                filesSynced: 0,
                bytesTransferred: 0,
                durationMs: Date.now() - startTime,
                errors: [err.message],
            };
        }
    }
    async pullFile(remoteFilePath, localFilePath) {
        const startTime = Date.now();
        const remoteSource = this.buildRemotePath(remoteFilePath);
        const rsyncCmd = this.buildRsyncCommand(remoteSource, localFilePath, 'pull');
        try {
            const result = await this.execAsync(rsyncCmd, 60000);
            const exists = fs_1.default.existsSync(localFilePath);
            const bytes = exists ? fs_1.default.statSync(localFilePath).size : 0;
            return {
                success: result.exitCode === 0,
                filesSynced: result.exitCode === 0 ? 1 : 0,
                bytesTransferred: bytes,
                durationMs: Date.now() - startTime,
                errors: result.exitCode !== 0 ? [result.stderr] : [],
            };
        }
        catch (err) {
            return {
                success: false,
                filesSynced: 0,
                bytesTransferred: 0,
                durationMs: Date.now() - startTime,
                errors: [err.message],
            };
        }
    }
    getSyncHistory(limit = 20) {
        return this.syncHistory.slice(-limit);
    }
    buildRemotePath(remotePath) {
        const port = this.config.port || 22;
        const hostPart = `${this.config.user}@${this.config.host}`;
        if (port !== 22) {
            return `${hostPart}:${remotePath}`;
        }
        return `${hostPart}:${remotePath}`;
    }
    buildRsyncCommand(src, dst, direction) {
        const parts = ['rsync', '-avz', '--stats'];
        if (this.config.port && this.config.port !== 22) {
            parts.push('-e', `"ssh -p ${this.config.port}"`);
        }
        if (this.config.keyPath) {
            const keyPart = this.config.port && this.config.port !== 22
                ? `-i ${this.config.keyPath} -p ${this.config.port}`
                : `-i ${this.config.keyPath}`;
            parts.push('-e', `"ssh ${keyPart}"`);
        }
        for (const pattern of this.config.excludePatterns || []) {
            parts.push('--exclude', pattern);
        }
        if (direction === 'pull') {
            const localDir = path_1.default.dirname(dst);
            if (!fs_1.default.existsSync(localDir)) {
                fs_1.default.mkdirSync(localDir, { recursive: true });
            }
        }
        parts.push(src.endsWith('/') ? src : src + '/');
        parts.push(dst.endsWith('/') ? dst : dst + '/');
        return parts.join(' ');
    }
    parseRsyncStats(output) {
        let files = 0;
        let bytes = 0;
        const fileMatch = output.match(/Number of (?:regular )?files transferred:\s*(\d+)/);
        if (fileMatch) {
            files = parseInt(fileMatch[1], 10);
        }
        const bytesMatch = output.match(/Total transferred file size:\s*([\d,]+)/);
        if (bytesMatch) {
            bytes = parseInt(bytesMatch[1].replace(/,/g, ''), 10);
        }
        return { files, bytes };
    }
    recordHistory(direction, result) {
        this.syncHistory.push({
            timestamp: Date.now(),
            direction,
            result,
        });
        if (this.syncHistory.length > 100) {
            this.syncHistory = this.syncHistory.slice(-50);
        }
        if (result.success) {
            Logger_1.Logger.info(`📁 文件同步 ${direction}: ${result.filesSynced} 文件, ${result.bytesTransferred} 字节, ${result.durationMs}ms`, 'FileSync');
        }
        else {
            Logger_1.Logger.warn(`📁 文件同步 ${direction} 失败: ${result.errors.join('; ')}`, 'FileSync');
        }
    }
    execAsync(command, timeout) {
        return new Promise((resolve) => {
            (0, child_process_1.exec)(command, {
                encoding: 'utf-8',
                timeout,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            }, (err, stdout, stderr) => {
                if (err) {
                    resolve({
                        stdout: stdout || '',
                        stderr: stderr || err.message,
                        exitCode: 1,
                    });
                }
                else {
                    resolve({
                        stdout: stdout || '',
                        stderr: stderr || '',
                        exitCode: 0,
                    });
                }
            });
        });
    }
}
exports.FileSyncService = FileSyncService;
