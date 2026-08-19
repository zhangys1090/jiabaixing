"use strict";
/**
 * 数据主权审计管道
 * 三重组合架构核心：数据主权 × 记忆深度的集成
 * 记录所有数据访问行为，生成可审计的数据流日志
 * 用户可随时查看"谁在什么时候访问了我的什么数据"
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
exports.DataSovereigntyPipeline = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DatabaseShim_1 = require("../shared/DatabaseShim");
const Logger_1 = require("../utils/Logger");
class DataSovereigntyPipeline {
    constructor(dbPath = './data/sovereignty_audit.db') {
        this.auditDb = null;
        this.dbPath = dbPath;
    }
    initialize() {
        try {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.auditDb = (0, DatabaseShim_1.createDatabase)(this.dbPath);
            if (!this.auditDb) {
                Logger_1.Logger.warn('⚠️ 数据主权审计管道：数据库降级为内存模式', 'DataSovereigntyPipeline');
                return true;
            }
            try {
                this.auditDb.pragma('journal_mode = WAL');
            }
            catch (err) {
                Logger_1.Logger.debug(`数据主权审计管道: WAL模式设置失败: ${err?.message}`, 'DataSovereigntyPipeline');
            }
            this.auditDb.exec(`
        CREATE TABLE IF NOT EXISTS data_access_audit (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          data_type TEXT NOT NULL,
          operation TEXT NOT NULL,
          purpose TEXT NOT NULL,
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          data_size INTEGER DEFAULT 0,
          is_local INTEGER DEFAULT 1
        )
      `);
            this.auditDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON data_access_audit(timestamp)
      `);
            this.auditDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_data_type ON data_access_audit(data_type)
      `);
            Logger_1.Logger.info('✅ 数据主权审计管道已初始化', 'DataSovereigntyPipeline');
            return true;
        }
        catch (error) {
            this.auditDb = null;
            Logger_1.Logger.error('数据主权审计管道初始化失败（将降级运行，请执行 npm run fix:native）', error, 'DataSovereigntyPipeline');
            return false;
        }
    }
    recordAccess(record) {
        if (!this.auditDb)
            return;
        const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        try {
            const stmt = this.auditDb.prepare(`INSERT INTO data_access_audit (id, timestamp, data_type, operation, purpose, source, target, data_size, is_local)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            stmt.run(id, record.timestamp, record.dataType, record.operation, record.purpose, record.source, record.target, record.dataSize, record.isLocal ? 1 : 0);
            this.pruneOldRecords();
        }
        catch (error) {
            Logger_1.Logger.error('审计记录写入失败', error, 'DataSovereigntyPipeline');
        }
    }
    generateReport() {
        if (!this.auditDb) {
            return this.emptyReport();
        }
        const totalAccesses = this.auditDb
            .prepare('SELECT COUNT(*) as count FROM data_access_audit')
            .get().count;
        const localOnlyAccesses = this.auditDb
            .prepare('SELECT COUNT(*) as count FROM data_access_audit WHERE is_local = 1')
            .get().count;
        const externalAccesses = totalAccesses - localOnlyAccesses;
        const encryptedCount = this.auditDb
            .prepare("SELECT COUNT(*) as count FROM data_access_audit WHERE purpose LIKE '%encrypt%'")
            .get().count;
        const writeCount = this.auditDb
            .prepare("SELECT COUNT(*) as count FROM data_access_audit WHERE operation = 'write'")
            .get().count;
        const encryptionRate = writeCount > 0 ? encryptedCount / writeCount : 0;
        const typeRows = this.auditDb
            .prepare('SELECT data_type, COUNT(*) as count FROM data_access_audit GROUP BY data_type')
            .all();
        const dataTypesBreakdown = {};
        for (const row of typeRows) {
            dataTypesBreakdown[row.data_type] = row.count;
        }
        const recentAccesses = this.auditDb
            .prepare('SELECT * FROM data_access_audit ORDER BY timestamp DESC LIMIT 20')
            .all().map((row) => ({
            id: row.id,
            timestamp: row.timestamp,
            dataType: row.data_type,
            operation: row.operation,
            purpose: row.purpose,
            source: row.source,
            target: row.target,
            dataSize: row.data_size,
            isLocal: row.is_local === 1,
        }));
        const sovereigntyScore = this.calculateSovereigntyScore(totalAccesses, localOnlyAccesses, encryptionRate);
        return {
            totalAccesses,
            localOnlyAccesses,
            externalAccesses,
            encryptionRate,
            dataTypesBreakdown,
            recentAccesses,
            sovereigntyScore,
        };
    }
    calculateSovereigntyScore(total, local, encryptionRate) {
        if (total === 0)
            return 100;
        const score = (local / total) * 70 + encryptionRate * 30;
        return Math.round(Math.min(100, Math.max(0, score)));
    }
    pruneOldRecords() {
        if (!this.auditDb)
            return;
        const count = this.auditDb
            .prepare('SELECT COUNT(*) as count FROM data_access_audit')
            .get().count;
        if (count > DataSovereigntyPipeline.MAX_AUDIT_RECORDS) {
            const cutoff = count - DataSovereigntyPipeline.MAX_AUDIT_RECORDS * 0.8;
            this.auditDb
                .prepare('DELETE FROM data_access_audit WHERE rowid IN (SELECT rowid FROM data_access_audit ORDER BY timestamp ASC LIMIT ?)')
                .run(cutoff);
        }
    }
    emptyReport() {
        return {
            totalAccesses: 0,
            localOnlyAccesses: 0,
            externalAccesses: 0,
            encryptionRate: 0,
            dataTypesBreakdown: {},
            recentAccesses: [],
            sovereigntyScore: 100,
        };
    }
    shutdown() {
        if (this.auditDb) {
            this.auditDb.close();
            this.auditDb = null;
        }
    }
}
exports.DataSovereigntyPipeline = DataSovereigntyPipeline;
DataSovereigntyPipeline.MAX_AUDIT_RECORDS = 50000;
