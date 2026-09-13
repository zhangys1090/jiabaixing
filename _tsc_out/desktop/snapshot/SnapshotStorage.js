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
exports.SnapshotStorage = void 0;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const FileSystem_1 = require("../../io/FileSystem");
const Logger_1 = require("../../utils/Logger");
const types_1 = require("./types");
const fileSystem = FileSystem_1.FileSystem.getInstance();
class SnapshotStorage {
    static instance = null;
    config;
    metadataIndex = new Map();
    indexFilePath;
    constructor(config) {
        this.config = config;
        this.indexFilePath = path.join(this.config.storageDir, 'index.json');
    }
    static getInstance(config) {
        if (!SnapshotStorage.instance) {
            SnapshotStorage.instance = new SnapshotStorage(config || {});
        }
        return SnapshotStorage.instance;
    }
    static reset() {
        SnapshotStorage.instance = null;
    }
    updateConfig(config) {
        this.config = config;
        this.indexFilePath = path.join(this.config.storageDir, 'index.json');
    }
    getMetadataIndex() {
        return this.metadataIndex;
    }
    setMetadataIndex(index) {
        this.metadataIndex = index;
    }
    getMetadata(snapshotId) {
        return this.metadataIndex.get(snapshotId);
    }
    setMetadata(snapshotId, metadata) {
        this.metadataIndex.set(snapshotId, metadata);
    }
    deleteMetadata(snapshotId) {
        return this.metadataIndex.delete(snapshotId);
    }
    async ensureStorageDir() {
        await fileSystem.ensureDir(this.config.storageDir);
    }
    async loadIndex() {
        try {
            const data = await fileSystem.readFile(this.indexFilePath);
            const indexData = JSON.parse(data);
            this.metadataIndex = new Map(indexData.map((meta) => [meta.snapshotId, meta]));
        }
        catch {
            this.metadataIndex = new Map();
        }
    }
    async saveIndex() {
        const indexData = Array.from(this.metadataIndex.values());
        await fileSystem.writeFile(this.indexFilePath, JSON.stringify(indexData, null, 2));
    }
    async saveSnapshotToFile(snapshot) {
        const fileName = `${snapshot.snapshotId}.json`;
        const filePath = path.join(this.config.storageDir, fileName);
        const data = JSON.stringify(snapshot, null, 2);
        if (this.config.compressStorage) {
            const zlib = await Promise.resolve().then(() => __importStar(require('zlib')));
            const compressed = zlib.deflateSync(Buffer.from(data));
            await fileSystem.writeFile(filePath + '.gz', compressed);
            return filePath + '.gz';
        }
        await fileSystem.writeFile(filePath, data, { atomic: false });
        return filePath;
    }
    async loadSnapshot(snapshotId) {
        const meta = this.metadataIndex.get(snapshotId);
        if (!meta)
            return null;
        try {
            let data;
            if (meta.filePath.endsWith('.gz')) {
                const zlib = await Promise.resolve().then(() => __importStar(require('zlib')));
                const compressed = await fileSystem.readFileBuffer(meta.filePath);
                data = zlib.inflateSync(compressed).toString('utf-8');
            }
            else {
                data = await fileSystem.readFile(meta.filePath);
            }
            const snapshot = JSON.parse(data);
            if (this.config.enableChecksum && meta.checksum) {
                const actualChecksum = this.calculateChecksum(data);
                if (actualChecksum !== meta.checksum) {
                    Logger_1.Logger.error(`⚠️ 快照校验和不匹配: ${snapshotId}`, new Error(`Checksum mismatch: expected ${meta.checksum}, got ${actualChecksum}`), 'SnapshotStorage');
                    meta.status = types_1.SnapshotStatus.CORRUPTED;
                    await this.saveIndex();
                    return null;
                }
            }
            return snapshot;
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 加载快照失败: ${snapshotId}`, error, 'SnapshotStorage');
            return null;
        }
    }
    async deleteSnapshotFile(snapshotId) {
        const meta = this.metadataIndex.get(snapshotId);
        if (!meta)
            return false;
        try {
            await fileSystem.deleteFile(meta.filePath);
            this.metadataIndex.delete(snapshotId);
            await this.saveIndex();
            Logger_1.Logger.info(`🗑️ 快照已删除: ${snapshotId}`, 'SnapshotStorage');
            return true;
        }
        catch (error) {
            Logger_1.Logger.error(`❌ 删除快照失败: ${snapshotId}`, error, 'SnapshotStorage');
            return false;
        }
    }
    async listSnapshots(options = {}) {
        let results = Array.from(this.metadataIndex.values());
        if (options.startTime) {
            results = results.filter((m) => m.timestamp >= options.startTime);
        }
        if (options.endTime) {
            results = results.filter((m) => m.timestamp <= options.endTime);
        }
        if (options.triggerTypes?.length) {
            results = results.filter((m) => options.triggerTypes.includes(m.triggerType));
        }
        if (options.tags?.length) {
            results = results.filter((m) => options.tags.some((tag) => m.tags.includes(tag)));
        }
        if (options.status) {
            results = results.filter((m) => m.status === options.status);
        }
        results.sort((a, b) => b.timestamp - a.timestamp);
        const offset = options.offset || 0;
        const limit = options.limit || results.length;
        return results.slice(offset, offset + limit);
    }
    async getLatestSnapshot() {
        const snapshots = await this.listSnapshots({ limit: 1 });
        return snapshots[0] || null;
    }
    async cleanupExpiredSnapshots(snapshotExpiryMs) {
        if (snapshotExpiryMs <= 0)
            return 0;
        const now = Date.now();
        const expired = [];
        for (const [id, meta] of this.metadataIndex) {
            if (now - meta.timestamp > snapshotExpiryMs) {
                expired.push(id);
            }
        }
        for (const id of expired) {
            await this.deleteSnapshotFile(id);
        }
        Logger_1.Logger.info(`🧹 清理 ${expired.length} 个过期快照`, 'SnapshotStorage');
        return expired.length;
    }
    async getSnapshotFileSize(filePath) {
        const info = await fileSystem.getFileInfo(filePath);
        return info.size;
    }
    calculateChecksum(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }
    async enforceMaxSnapshotCount(maxCount) {
        const all = Array.from(this.metadataIndex.values()).sort((a, b) => a.timestamp - b.timestamp);
        if (all.length > maxCount) {
            const toDelete = all.slice(0, all.length - maxCount);
            for (const meta of toDelete) {
                await this.deleteSnapshotFile(meta.snapshotId);
            }
        }
    }
}
exports.SnapshotStorage = SnapshotStorage;
