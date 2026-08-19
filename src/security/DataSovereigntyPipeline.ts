/**
 * 数据主权审计管道
 * 三重组合架构核心：数据主权 × 记忆深度的集成
 * 记录所有数据访问行为，生成可审计的数据流日志
 * 用户可随时查看"谁在什么时候访问了我的什么数据"
 */

import * as fs from 'fs';
import * as path from 'path';
import { createDatabase } from '../shared/DatabaseShim';
import { Logger } from '../utils/Logger';

export interface DataAccessRecord {
  id: string;
  timestamp: string;
  dataType: 'memory' | 'profile' | 'emotion' | 'conversation' | 'embedding';
  operation: 'read' | 'write' | 'delete' | 'export' | 'encrypt';
  purpose: string;
  source: string;
  target: string;
  dataSize: number;
  isLocal: boolean;
}

export interface DataSovereigntyReport {
  totalAccesses: number;
  localOnlyAccesses: number;
  externalAccesses: number;
  encryptionRate: number;
  dataTypesBreakdown: Record<string, number>;
  recentAccesses: DataAccessRecord[];
  sovereigntyScore: number;
}

export class DataSovereigntyPipeline {
  private auditDb: import('../shared/DatabaseShim').DatabaseAdapter | null =
    null;
  private dbPath: string;
  private static readonly MAX_AUDIT_RECORDS = 50000;

  constructor(dbPath: string = './data/sovereignty_audit.db') {
    this.dbPath = dbPath;
  }

  public initialize(): boolean {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.auditDb = createDatabase(this.dbPath);
      if (!this.auditDb) {
        Logger.warn(
          '⚠️ 数据主权审计管道：数据库降级为内存模式',
          'DataSovereigntyPipeline'
        );
        return true;
      }
      try {
        this.auditDb.pragma('journal_mode = WAL');
      } catch {}

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

      Logger.info('✅ 数据主权审计管道已初始化', 'DataSovereigntyPipeline');
      return true;
    } catch (error) {
      this.auditDb = null;
      Logger.error(
        '数据主权审计管道初始化失败（将降级运行，请执行 npm run fix:native）',
        error as Error,
        'DataSovereigntyPipeline'
      );
      return false;
    }
  }

  public recordAccess(record: Omit<DataAccessRecord, 'id'>): void {
    if (!this.auditDb) return;

    const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      const stmt = this.auditDb.prepare(
        `INSERT INTO data_access_audit (id, timestamp, data_type, operation, purpose, source, target, data_size, is_local)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(
        id,
        record.timestamp,
        record.dataType,
        record.operation,
        record.purpose,
        record.source,
        record.target,
        record.dataSize,
        record.isLocal ? 1 : 0
      );

      this.pruneOldRecords();
    } catch (error) {
      Logger.error(
        '审计记录写入失败',
        error as Error,
        'DataSovereigntyPipeline'
      );
    }
  }

  public generateReport(): DataSovereigntyReport {
    if (!this.auditDb) {
      return this.emptyReport();
    }

    const totalAccesses = (
      this.auditDb
        .prepare('SELECT COUNT(*) as count FROM data_access_audit')
        .get() as {
        count: number;
      }
    ).count;

    const localOnlyAccesses = (
      this.auditDb
        .prepare(
          'SELECT COUNT(*) as count FROM data_access_audit WHERE is_local = 1'
        )
        .get() as { count: number }
    ).count;

    const externalAccesses = totalAccesses - localOnlyAccesses;

    const encryptedCount = (
      this.auditDb
        .prepare(
          "SELECT COUNT(*) as count FROM data_access_audit WHERE purpose LIKE '%encrypt%'"
        )
        .get() as { count: number }
    ).count;

    const writeCount = (
      this.auditDb
        .prepare(
          "SELECT COUNT(*) as count FROM data_access_audit WHERE operation = 'write'"
        )
        .get() as { count: number }
    ).count;

    const encryptionRate = writeCount > 0 ? encryptedCount / writeCount : 0;

    const typeRows = this.auditDb
      .prepare(
        'SELECT data_type, COUNT(*) as count FROM data_access_audit GROUP BY data_type'
      )
      .all() as Array<{ data_type: string; count: number }>;

    const dataTypesBreakdown: Record<string, number> = {};
    for (const row of typeRows) {
      dataTypesBreakdown[row.data_type] = row.count;
    }

    const recentAccesses = (
      this.auditDb
        .prepare(
          'SELECT * FROM data_access_audit ORDER BY timestamp DESC LIMIT 20'
        )
        .all() as Array<{
        id: string;
        timestamp: string;
        data_type: string;
        operation: string;
        purpose: string;
        source: string;
        target: string;
        data_size: number;
        is_local: number;
      }>
    ).map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      dataType: row.data_type as DataAccessRecord['dataType'],
      operation: row.operation as DataAccessRecord['operation'],
      purpose: row.purpose,
      source: row.source,
      target: row.target,
      dataSize: row.data_size,
      isLocal: row.is_local === 1,
    }));

    const sovereigntyScore = this.calculateSovereigntyScore(
      totalAccesses,
      localOnlyAccesses,
      encryptionRate
    );

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

  private calculateSovereigntyScore(
    total: number,
    local: number,
    encryptionRate: number
  ): number {
    if (total === 0) return 100;

    const score = (local / total) * 70 + encryptionRate * 30;
    return Math.round(Math.min(100, Math.max(0, score)));
  }

  private pruneOldRecords(): void {
    if (!this.auditDb) return;

    const count = (
      this.auditDb
        .prepare('SELECT COUNT(*) as count FROM data_access_audit')
        .get() as {
        count: number;
      }
    ).count;

    if (count > DataSovereigntyPipeline.MAX_AUDIT_RECORDS) {
      const cutoff = count - DataSovereigntyPipeline.MAX_AUDIT_RECORDS * 0.8;
      this.auditDb
        .prepare(
          'DELETE FROM data_access_audit WHERE rowid IN (SELECT rowid FROM data_access_audit ORDER BY timestamp ASC LIMIT ?)'
        )
        .run(cutoff);
    }
  }

  private emptyReport(): DataSovereigntyReport {
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

  public shutdown(): void {
    if (this.auditDb) {
      this.auditDb.close();
      this.auditDb = null;
    }
  }
}
