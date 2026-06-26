/**
 * SqliteCacheStore 单元测试
 *
 * 测试持久化缓存的 CRUD、TTL、淘汰策略。
 * 使用手工 mock 的 DatabaseAdapter，避免 MemoryDatabase 的 SQL 兼容性限制。
 */

import { SqliteCacheStore } from '../../../src/models/SqliteCacheStore';
import type { DatabaseAdapter } from '../../../src/shared/DatabaseShim';

/** PreparedStatement 返回类型 */
type PreparedStatementLike = ReturnType<DatabaseAdapter['prepare']>;

/** 简易内存表，模拟 SQLite 存储 */
class MockTable {
  rows: Array<Record<string, unknown>> = [];
}

/** 简易内存数据库适配器，支持 SqliteCacheStore 用到的 SQL 操作 */
class TestDatabase implements DatabaseAdapter {
  private tables = new Map<string, MockTable>();

  exec(_sql: string): void {
    // 忽略 DDL，表结构由 test 管理
  }

  prepare(sql: string): PreparedStatementLike {
    return new TestStatement(this, sql);
  }

  pragma(_key: string, _value?: string): void {
    // no-op
  }

  close(): void {
    this.tables.clear();
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return fn;
  }

  getTable(name: string): MockTable {
    if (!this.tables.has(name)) {
      this.tables.set(name, new MockTable());
    }
    return this.tables.get(name)!;
  }
}

class TestStatement implements PreparedStatementLike {
  private db: TestDatabase;
  private sql: string;
  private tableName: string;
  private isInsert: boolean;
  private isReplace: boolean;
  private isDelete: boolean;
  private isSelect: boolean;
  private columns: string[];

  constructor(db: TestDatabase, sql: string) {
    this.db = db;
    this.sql = sql;

    const insertMatch = sql.match(
      /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)\s*(?:\(([^)]*)\))?/i
    );
    this.isInsert = !!insertMatch;
    this.isReplace = this.isInsert && /OR\s+REPLACE/i.test(sql);
    this.tableName = insertMatch?.[1] || '';
    this.columns = insertMatch?.[2]
      ? insertMatch[2].split(',').map((c) => c.trim().replace(/[`@]/g, ''))
      : [];

    this.isDelete = /^\s*DELETE/i.test(sql);
    if (this.isDelete) {
      const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
      this.tableName = deleteMatch?.[1] || '';
    }

    this.isSelect = /^\s*SELECT/i.test(sql);
    if (this.isSelect) {
      const selectMatch = sql.match(/FROM\s+(\w+)/i);
      this.tableName = selectMatch?.[1] || '';
    }
  }

  private parseLiteral(val: string): unknown {
    const trimmed = val.trim();
    // 数字字面量
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // 字符串字面量: 'value'
    if (trimmed.startsWith("'") && trimmed.endsWith("'"))
      return trimmed.slice(1, -1);
    // NULL
    if (trimmed.toUpperCase() === 'NULL') return null;
    return trimmed;
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const table = this.db.getTable(this.tableName);

    if (this.isInsert) {
      // 支持命名参数对象和位置参数
      let row: Record<string, unknown> = {};

      if (
        args.length === 1 &&
        typeof args[0] === 'object' &&
        !Array.isArray(args[0])
      ) {
        row = { ...(args[0] as Record<string, unknown>) };
      } else {
        // 位置参数: 解析 VALUES 中的 ? 占位符，跳过字面量
        const valuesMatch = this.sql.match(/VALUES\s*\(([^)]+)\)/i);
        const placeholders = valuesMatch
          ? valuesMatch[1].split(',').map((v) => v.trim())
          : [];

        let argIdx = 0;
        for (let i = 0; i < this.columns.length; i++) {
          const valPlaceholder = placeholders[i];
          if (valPlaceholder === '?') {
            row[this.columns[i]] = args[argIdx++] ?? null;
          } else {
            // 字面量，如 0、'string'
            row[this.columns[i]] = this.parseLiteral(valPlaceholder);
          }
        }
      }

      if (this.isReplace) {
        // 查找已存在的主键（第一列 = key）
        const keyCol = this.columns[0];
        if (keyCol && row[keyCol] !== undefined) {
          const existing = table.rows.findIndex(
            (r) => r[keyCol] === row[keyCol]
          );
          if (existing >= 0) {
            table.rows[existing] = { ...table.rows[existing], ...row };
            return { changes: 1, lastInsertRowid: existing + 1 };
          }
        }
      }

      table.rows.push(row);
      return { changes: 1, lastInsertRowid: table.rows.length };
    }

    if (this.isDelete) {
      const conditions = this.parseWhere();
      const before = table.rows.length;
      table.rows = table.rows.filter(
        (row) => !this.rowMatches(row, conditions, args)
      );
      return { changes: before - table.rows.length, lastInsertRowid: 0 };
    }

    return { changes: 0, lastInsertRowid: 0 };
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    const rows = this.all(...args);
    return rows[0];
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    const table = this.db.getTable(this.tableName);
    if (!table.rows.length) return [];

    const conditions = this.parseWhere();
    let results = table.rows.filter((row) =>
      this.rowMatches(row, conditions, args)
    );

    // ORDER BY
    const orderMatch = this.sql.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    if (orderMatch) {
      const col = orderMatch[1];
      const dir = (orderMatch[2] || 'ASC').toUpperCase();
      results = [...results].sort((a, b) => {
        const va = a[col] ?? 0;
        const vb = b[col] ?? 0;
        return dir === 'DESC' ? (vb > va ? 1 : -1) : va > vb ? 1 : -1;
      });
    }

    // LIMIT
    const limitMatch = this.sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      results = results.slice(0, parseInt(limitMatch[1], 10));
    }

    // 聚合查询
    if (this.sql.includes('COUNT(*)')) {
      return [{ count: results.length }];
    }
    if (this.sql.includes('SUM(LENGTH(value))')) {
      const total = results.reduce(
        (sum: number, row: Record<string, unknown>) => {
          const val = row.value as string;
          return sum + (val ? val.length : 0);
        },
        0
      );
      return [{ total }];
    }

    return results;
  }

  private parseWhere(): Array<{ col: string; op: string; val: string | null }> {
    const whereMatch = this.sql.match(
      /WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s*$)/i
    );
    if (!whereMatch) return [];

    return whereMatch[1].split(/\s+AND\s+/i).map((part) => {
      const eq = part.match(/(\w+)\s*=\s*(.+)/);
      const gt = part.match(/(\w+)\s*>\s*(\d+)/);
      const gte = part.match(/(\w+)\s*>=\s*(\d+)/);
      const lt = part.match(/(\w+)\s*<\s*(\d+)/);

      if (eq) {
        const rawVal = eq[2].replace(/^'(.*)'$/, '$1');
        return { col: eq[1], op: '=', val: rawVal };
      }
      if (gte) return { col: gte[1], op: '>=', val: gte[2] };
      if (gt) return { col: gt[1], op: '>', val: gt[2] };
      if (lt) return { col: lt[1], op: '<', val: lt[2] };
      return { col: part.trim(), op: 'EXISTS', val: null };
    });
  }

  private rowMatches(
    row: Record<string, unknown>,
    conditions: Array<{ col: string; op: string; val: string | null }>,
    args: unknown[]
  ): boolean {
    if (conditions.length === 0) return true;

    // 参数索引（用于 ? 占位符）
    let paramIdx = 0;

    return conditions.every((cond) => {
      let targetVal: unknown = cond.val;

      // 替换 ? 占位符
      if (cond.val === '?') {
        targetVal = args[paramIdx++];
      } else if (cond.val && cond.val.startsWith('@')) {
        const paramName = cond.val.slice(1);
        targetVal = (args[0] as Record<string, unknown>)?.[paramName];
      }

      const cellVal = row[cond.col];

      switch (cond.op) {
        case '=':
          return cellVal === targetVal;
        case '>':
          return (cellVal as number) > (targetVal as number);
        case '>=':
          return (cellVal as number) >= (targetVal as number);
        case '<':
          return (cellVal as number) < (targetVal as number);
        default:
          return true;
      }
    });
  }
}

describe('SqliteCacheStore', () => {
  let store: SqliteCacheStore;
  let testDb: TestDatabase;

  beforeEach(() => {
    testDb = new TestDatabase();
    store = new SqliteCacheStore(':memory:', undefined, testDb);
  });

  afterEach(() => {
    store.close();
  });

  describe('基本 CRUD', () => {
    it('应存储和读取条目', () => {
      store.set('key1', 'hello', 60000);
      const entry = store.get('key1');
      expect(entry).toBeDefined();
      expect(entry).toBe('hello');
    });

    it('不存在的 key 应返回 undefined', () => {
      const entry = store.get('nonexistent');
      expect(entry).toBeUndefined();
    });

    it('应更新已存在的条目（INSERT OR REPLACE）', () => {
      store.set('key1', 'old', 60000);
      store.set('key1', 'new', 60000);
      const entry = store.get('key1');
      expect(entry).toBeDefined();
      expect(entry).toBe('new');
    });

    it('应删除条目', () => {
      store.set('key1', 'hello', 60000);
      const deleted = store.delete('key1');
      expect(deleted).toBe(true);
      expect(store.get('key1')).toBeUndefined();
    });

    it('删除不存在的条目应返回 false', () => {
      const deleted = store.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('TTL 过期', () => {
    it('应在 TTL 后返回 undefined', () => {
      store.set('fast', 'gone', 1); // 1ms TTL
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const entry = store.get('fast');
          expect(entry).toBeUndefined();
          resolve();
        }, 50);
      });
    });

    it('未过期的条目应正常返回', () => {
      store.set('persist', 'here', 60000);
      const entry = store.get('persist');
      expect(entry).toBeDefined();
      expect(entry).toBe('here');
    });
  });

  describe('按类型清除', () => {
    it('应只清除指定类型的条目', () => {
      store.set('r1', 'resp', 60000, 'response');
      store.set('p1', '1', 60000, 'prefix');

      // 清除前：两个条目都在
      expect(store.get('r1')).toBeDefined();
      expect(store.get('p1')).toBeDefined();

      store.clearByKind('prefix');

      // response 条目应仍在
      expect(store.get('r1')).toBeDefined();
      // prefix 条目应已删除
      expect(store.get('p1')).toBeUndefined();
    });

    it('清空全部应删除所有条目', () => {
      store.set('a', '1', 60000);
      store.set('b', '2', 60000);

      store.clear();
      expect(store.get('a')).toBeUndefined();
      expect(store.get('b')).toBeUndefined();
    });
  });

  describe('命中率统计', () => {
    it('应记录命中次数', () => {
      store.set('hitme', 'data', 60000);
      store.get('hitme');
      store.get('hitme');

      const stats = store.getStats();
      expect(stats.hits).toBe(2);
    });

    it('应记录未命中次数', () => {
      store.get('miss1');
      store.get('miss2');

      const stats = store.getStats();
      expect(stats.misses).toBe(2);
    });

    it('应计算命中率', () => {
      store.set('hitme', 'data', 60000);
      store.get('hitme'); // 命中
      store.get('missing'); // 未命中

      const stats = store.getStats();
      expect(stats.hitRate).toBeCloseTo(0.5, 1);
    });
  });

  describe('条目元数据', () => {
    it('应返回条目列表（含 kind）', () => {
      // 直接调用 listEntries 验证插入条目包含元数据
      store.set('k1', 'v1', 60000, 'response');
      store.set('k2', 'v2', 60000, 'prefix');

      const all = store.listEntries();
      // 除了我们设置的 2 条，可能还有因为 MemoryDatabase 插入
      // 产生的「幽灵行」，所以我们只验证 k1/k2 可见
      const k1 = all.find((e) => e.key === 'k1');
      const k2 = all.find((e) => e.key === 'k2');
      expect(k1).toBeDefined();
      expect(k1!.kind).toBe('response');
      expect(k2).toBeDefined();
      expect(k2!.kind).toBe('prefix');
    });

    it('应按类型过滤条目列表', () => {
      store.set('k1', 'v1', 60000, 'response');
      store.set('k2', 'v2', 60000, 'prefix');

      const responses = store.listEntries('response');
      const k1 = responses.find((e) => e.key === 'k1');
      expect(k1).toBeDefined();
      expect(k1!.kind).toBe('response');

      // prefix 条目不应在 response 列表中
      const k2 = responses.find((e) => e.key === 'k2');
      expect(k2).toBeUndefined();
    });
  });
});
