/**
 * better-sqlite3 WSL 兼容适配器
 *
 * 当原生模块因平台不兼容（如 WSL 下加载 Win32 编译的 .node）加载失败时，
 * 自动降级为内存模式，不阻塞系统启动。
 *
 * 用法：在需要 import Database from 'better-sqlite3' 的地方改为：
 *   import { createDatabase } from '../shared/DatabaseShim';
 *   const db = createDatabase(path);
 *
 * 返回的 db 对象 API 兼容 better-sqlite3 的 .exec() .prepare() .get() .all() .run() .close() 方法。
 */

import * as fs from 'fs';
import * as path from 'path';

// 尝试加载原生 better-sqlite3
let BetterDatabase: (new (dbPath: string) => DatabaseAdapter) | null = null;
let nativeAvailable = false;

try {
  // 先验证模块是否能正常加载和使用
  const mod = require('better-sqlite3');
  // 尝试创建内存数据库验证
  const testDb = new mod(':memory:');
  testDb.exec('SELECT 1 AS test');
  testDb.close();
  BetterDatabase = mod;
  nativeAvailable = true;
} catch (e) {
  nativeAvailable = false;
  console.warn(
    '[DatabaseShim] better-sqlite3 原生模块不可用，将使用内存降级模式:',
    (e as Error).message
  );
}

export { nativeAvailable };

/** 数据库适配器接口（兼容 better-sqlite3 API） */
export interface DatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  };
  pragma(pragma: string, value?: unknown): unknown;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  close(): void;
}

/**
 * 创建数据库实例。
 * 优先使用原生 better-sqlite3，失败时降级为内存模式。
 */
export function createDatabase(dbPath: string): DatabaseAdapter {
  if (nativeAvailable) {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const db = new BetterDatabase!(dbPath);

      try {
        db.pragma('journal_mode = WAL');
      } catch {}
      try {
        db.pragma('synchronous = NORMAL');
      } catch {}
      try {
        db.pragma('temp_store = MEMORY');
      } catch {}
      try {
        db.pragma('mmap_size = 268435456');
      } catch {}
      try {
        db.pragma('cache_size = -64000');
      } catch {}

      return db as DatabaseAdapter;
    } catch (e) {
      console.warn(
        '[DatabaseShim] 创建数据库失败，降级为内存模式:',
        (e as Error).message
      );
    }
  }
  return new MemoryDatabase() as DatabaseAdapter;
}

/**
 * 内存数据库 — 纯 JS 实现，API 兼容 better-sqlite3 的子集。
 *
 * 支持：exec(), prepare().run().get().all(), pragma(), close()
 * 不支持：transaction()（自动退化为直接执行）, FTS5
 */
class MemoryDatabase {
  private _closed = false;
  private tables: Map<string, MemoryTable> = new Map();

  get closed(): boolean {
    return this._closed;
  }

  pragma(_key: string, _value?: string): void {
    // 内存模式下所有 pragma 不生效，静默忽略
  }

  exec(sql: string): void {
    if (this._closed) throw new Error('Database is closed');

    // 按分号分割多语句 SQL，逐条处理
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      // CREATE TABLE IF NOT EXISTS
      const createMatch = stmt.match(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*)\)\s*$/i
      );
      if (createMatch) {
        const tableName = createMatch[1];
        if (!this.tables.has(tableName)) {
          const columns = parseColumns(createMatch[2]);
          this.tables.set(tableName, new MemoryTable(tableName, columns));
        }
        continue;
      }

      // CREATE INDEX — 忽略
      if (/CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt)) continue;
      // CREATE VIRTUAL TABLE — 忽略
      if (/CREATE\s+VIRTUAL\s+TABLE/i.test(stmt)) continue;
      // CREATE TRIGGER — 忽略
      if (/CREATE\s+TRIGGER/i.test(stmt)) continue;

      // ALTER TABLE ADD COLUMN
      const alterMatch = stmt.match(
        /ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)/i
      );
      if (alterMatch) {
        const table = this.tables.get(alterMatch[1]);
        if (table) table.addColumn(alterMatch[2]);
        continue;
      }

      // INSERT INTO ... _fts — 忽略
      if (/INSERT\s+INTO\s+\w+_fts/i.test(stmt)) continue;

      // DELETE FROM table (全表)
      const deleteMatch = stmt.match(/DELETE\s+FROM\s+(\w+)\s*$/i);
      if (deleteMatch) {
        const table = this.tables.get(deleteMatch[1]);
        if (table) table.clear();
        continue;
      }
    }
  }

  prepare(sql: string): PreparedStatement {
    if (this._closed) throw new Error('Database is closed');
    return new PreparedStatement(this, this.tables, sql);
  }

  close(): void {
    this._closed = true;
    this.tables.clear();
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    // 内存模式下退化为直接执行（无事务隔离）
    return fn;
  }
}

/** SQL 表的内存表示 */
class MemoryTable {
  name: string;
  columns: string[];
  rows: (string | number | null)[][] = [];
  autoIncrement = 1;

  constructor(name: string, columns: string[]) {
    this.name = name;
    this.columns = columns;
  }

  addColumn(col: string): void {
    if (!this.columns.includes(col)) {
      this.columns.push(col);
      for (const row of this.rows) row.push(null);
    }
  }

  clear(): void {
    this.rows = [];
  }

  getColIndex(col: string): number {
    const idx = this.columns.indexOf(col);
    if (idx < 0) throw new Error(`列不存在: ${col}`);
    return idx;
  }

  insertRow(values: (string | number | null)[]): number {
    const row = new Array(this.columns.length).fill(null);
    for (let i = 0; i < values.length && i < this.columns.length; i++) {
      row[i] = values[i];
    }
    this.rows.push(row);
    return this.autoIncrement++;
  }
}

class PreparedStatement {
  private tables: Map<string, MemoryTable>;
  private sql: string;
  private parsed: ParsedSQL;

  constructor(
    _db: MemoryDatabase,
    tables: Map<string, MemoryTable>,
    sql: string
  ) {
    this.tables = tables;
    this.sql = sql;
    this.parsed = this.parse(sql);
  }

  private parse(sql: string): ParsedSQL {
    const s = sql.trim().replace(/\s+/g, ' ');

    // INSERT OR REPLACE / INSERT INTO ... VALUES
    const insertRe =
      /^INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)\s*(?:\(([^)]*)\))?\s*VALUES\s*\(([^)]*)\)\s*$/i;
    const m = s.match(insertRe);
    if (m)
      return {
        type: 'insert',
        tableName: m[1],
        columns: m[2]
          ? m[2].split(',').map((c) => c.trim().replace(/[`@]/g, ''))
          : [],
        values: parseValues(m[3]),
      };

    // UPDATE ... SET ... WHERE ...
    const updateRe = /^UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i;
    const um = s.match(updateRe);
    if (um)
      return {
        type: 'update',
        tableName: um[1],
        setClause: um[2],
        whereClause: um[3] || '',
      };

    // DELETE FROM ... WHERE ...
    const delRe = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i;
    const dm = s.match(delRe);
    if (dm)
      return { type: 'delete', tableName: dm[1], whereClause: dm[2] || '' };

    // SELECT COUNT(*) / AVG() / SUM() 等聚合 — 必须在普通 SELECT 之前匹配
    const aggRe =
      /^SELECT\s+(COUNT\(\*\)|AVG\((\w+)\)|SUM\((\w+)\))\s+(?:as\s+)?(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?\s*$/i;
    const am = s.match(aggRe);
    if (am)
      return {
        type: 'aggregate',
        tableName: am[5],
        aggFn: am[0].toUpperCase().includes('COUNT')
          ? 'count'
          : am[0].toUpperCase().includes('AVG')
            ? 'avg'
            : 'sum',
        aggCol: am[2] || am[3] || '',
        alias: am[4],
        whereClause: am[6] || '',
      };

    // SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ...
    const selRe =
      /^SELECT\s+(DISTINCT\s+)?(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+|\?))?(?:\s+OFFSET\s+(\d+))?\s*$/i;
    const sm = s.match(selRe);
    if (sm) {
      const limitStr = sm[6];
      let limit: number | undefined;
      let limitIsPlaceholder = false;
      if (limitStr === '?') {
        limitIsPlaceholder = true;
      } else if (limitStr) {
        limit = parseInt(limitStr);
      }
      return {
        type: 'select',
        tableName: sm[3],
        selectExpr: sm[2],
        distinct: !!sm[1],
        whereClause: sm[4] || '',
        orderBy: sm[5] || '',
        limit,
        limitIsPlaceholder,
        offset: sm[7] ? parseInt(sm[7]) : 0,
      };
    }

    // PRAGMA table_info
    if (/^PRAGMA\s+table_info/i.test(s)) return { type: 'pragma_info' };
    // PRAGMA 其他
    if (/^PRAGMA\s+/i.test(s)) return { type: 'pragma' };

    return { type: 'unknown' };
  }

  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const p = this.parsed;
    const table = p.tableName ? this.tables.get(p.tableName) : undefined;

    if (p.type === 'insert') {
      if (!table) return { changes: 0, lastInsertRowid: 0 };
      const resolved = resolveArgs(
        args,
        p.values || [],
        p.columns || [],
        table.columns
      );
      const id = table.insertRow(resolved);
      return { changes: 1, lastInsertRowid: id };
    }

    if (p.type === 'update') {
      if (!table) return { changes: 0, lastInsertRowid: 0 };
      const assignments = parseSet(p.setClause || '', args);
      const rows = filterRows(table, p.whereClause || '', args);
      for (const row of rows) {
        for (const { col, val } of assignments) {
          try {
            const idx = table.getColIndex(col);
            row[idx] = val as string | number | null;
          } catch {
            // 跳过无效列名
          }
        }
      }
      return { changes: rows.length, lastInsertRowid: 0 };
    }

    if (p.type === 'delete') {
      if (!table) return { changes: 0, lastInsertRowid: 0 };
      const before = table.rows.length;
      if (!p.whereClause) {
        table.clear();
        return { changes: before, lastInsertRowid: 0 };
      }
      const toDelete = filterRows(table, p.whereClause, args);
      const keep = table.rows.filter((r) => !toDelete.includes(r));
      const deleted = table.rows.length - keep.length;
      table.rows = keep;
      return { changes: deleted, lastInsertRowid: 0 };
    }

    return { changes: 0, lastInsertRowid: 0 };
  }

  get(...args: unknown[]): unknown {
    const rows = this.all(...args);
    return rows.length > 0 ? rows[0] : undefined;
  }

  all(...args: unknown[]): Record<string, unknown>[] {
    const p = this.parsed;
    const table = p.tableName ? this.tables.get(p.tableName) : undefined;

    if (p.type === 'select') {
      if (!table) return [];

      let rows = table.rows;

      // WHERE 过滤
      if (p.whereClause) {
        rows = filterRows(table, p.whereClause, args);
      }

      // ORDER BY
      if (p.orderBy) {
        rows = sortRows(rows, table, p.orderBy);
      }

      // LIMIT / OFFSET
      if (p.offset) rows = rows.slice(p.offset);
      if (p.limit) rows = rows.slice(0, p.limit);
      if (p.limitIsPlaceholder) {
        // LIMIT ? 占位符：从 args 中取第一个参数作为 limit 值
        const limitVal =
          args.length === 1
            ? args[0]
            : Array.isArray(args[0])
              ? args[0][0]
              : args[0];
        if (typeof limitVal === 'number') rows = rows.slice(0, limitVal);
      }

      // DISTINCT
      if (p.distinct) {
        rows = rows.filter(
          (r, i, a) => a.findIndex((x) => x.every((v, j) => v === r[j])) === i
        );
      }

      return rowsToObjects(rows, table, p.selectExpr || '*');
    }

    if (p.type === 'aggregate') {
      if (!table) {
        const r: Record<string, unknown> = {};
        r[p.alias || 'result'] = 0;
        return [r];
      }
      let rows = table.rows;
      if (p.whereClause) {
        rows = filterRows(table, p.whereClause, args);
      }
      const vals = p.aggCol
        ? rows.map((r) => r[table.getColIndex(p.aggCol || '')])
        : [];
      let result: number;
      if (p.aggFn === 'count') result = rows.length;
      else if (p.aggFn === 'avg')
        result = vals.length
          ? (vals.reduce((a, b) => Number(a) + (Number(b) || 0), 0) as number) /
            vals.length
          : 0;
      else
        result = vals.reduce(
          (a, b) => Number(a) + (Number(b) || 0),
          0
        ) as number;
      const r: Record<string, unknown> = {};
      r[p.alias || 'result'] = result;
      return [r];
    }

    if (p.type === 'pragma_info') return [];

    return [];
  }
}

// --- 类型定义和辅助函数 ---

interface ParsedSQL {
  type: string;
  tableName?: string;
  columns?: string[];
  values?: string[];
  setClause?: string;
  whereClause?: string;
  selectExpr?: string;
  distinct?: boolean;
  orderBy?: string;
  limit?: number;
  limitIsPlaceholder?: boolean;
  offset?: number;
  aggFn?: string;
  aggCol?: string;
  alias?: string;
}

function parseColumns(colDefs: string): string[] {
  const cols: string[] = [];
  // 按逗号拆分列定义，但忽略括号内的逗号（如 CHECK(role IN ('admin', 'user'))）
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = '';
  for (const ch of colDefs) {
    if (inString) {
      current += ch;
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  for (const def of parts) {
    const m = def.trim().match(/^(`?\w+`?)/);
    if (m) cols.push(m[1].replace(/`/g, ''));
  }
  return cols;
}

function parseValues(valStr: string): string[] {
  return valStr.split(',').map((v) => v.trim());
}

function parseSet(
  setClause: string,
  args: unknown[]
): { col: string; val: string | number | null }[] {
  const assignments: { col: string; val: string | number | null }[] = [];
  const parts = setClause.split(',');
  for (const part of parts) {
    const m = part.trim().match(/(\w+)\s*=\s*(.+)/);
    if (!m) continue;
    const col = m[1];
    let val: string | number | null = m[2].trim();
    if (val === '?' || val.match(/^@\w+$/)) {
      val = resolveValue(val, args);
    }
    assignments.push({ col, val });
  }
  return assignments;
}

function resolveValue(
  placeholder: string,
  args: unknown[]
): string | number | null {
  if (placeholder === '?') return (args[0] as string | number | null) ?? null;
  const name = placeholder.replace(/^@/, '');
  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    const obj = args[0] as Record<string, unknown>;
    return (obj[name] ?? obj[`@${name}`] ?? null) as string | number | null;
  }
  return null;
}

function resolveArgs(
  args: unknown[],
  valuePatterns: string[],
  namedColumns: string[],
  tableColumns: string[]
): (string | number | null)[] {
  const result: (string | number | null)[] = [];

  // 情况1: 命名参数 { id: '...', content: '...' }
  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    for (const col of tableColumns) {
      let val = (args[0] as Record<string, unknown>)[col];
      if (val === undefined)
        val = (args[0] as Record<string, unknown>)[`@${col}`];
      result.push((val as string | number | null) ?? null);
    }
    return result;
  }

  // 情况2: 位置参数 [val1, val2, ...]
  if (namedColumns.length > 0) {
    for (const col of tableColumns) {
      const idx = namedColumns.indexOf(col);
      result.push(
        idx >= 0 && idx < args.length
          ? (args[idx] as string | number | null)
          : null
      );
    }
    return result;
  }

  // 情况3: VALUES (?, ?, ...)
  for (let i = 0; i < valuePatterns.length; i++) {
    result.push(
      valuePatterns[i] === '?' && i < args.length
        ? (args[i] as string | number | null)
        : null
    );
  }
  return result;
}

function filterRows(
  table: MemoryTable,
  whereClause: string,
  args: unknown[]
): (string | number | null)[][] {
  if (!whereClause) return table.rows;

  // 按 AND 拆分条件（跳过 1=1 这类常量真表达式）
  const conditions = whereClause.split(/\s+AND\s+/i).filter((c) => {
    const trimmed = c.trim();
    // 跳过 1=1, 1 = 1 等常量真表达式
    return !/^\s*1\s*=\s*1\s*$/.test(trimmed);
  });

  if (conditions.length === 0) return table.rows;

  let rows = table.rows;
  let paramIndex = 0;

  for (const cond of conditions) {
    // 匹配 IS NULL / IS NOT NULL
    const nullMatch = cond.trim().match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i);
    if (nullMatch) {
      const col = nullMatch[1];
      const isNotNull = !!nullMatch[2];
      let colIdx: number;
      try {
        colIdx = table.getColIndex(col);
      } catch {
        continue; // 跳过无效列名
      }
      rows = rows.filter((row) => {
        const cellVal = row[colIdx];
        return isNotNull
          ? cellVal !== null && cellVal !== undefined
          : cellVal === null || cellVal === undefined;
      });
      continue;
    }

    // 匹配 col OP value，支持 =, >=, <=, >, <, !=
    const condMatch = cond.trim().match(/(\w+)\s*(>=|<=|!=|<>|>|<|=)\s*(.+)/);
    if (!condMatch) continue;

    const col = condMatch[1];
    const op = condMatch[2];
    let targetVal: string | number | null = condMatch[3].trim();

    // 处理占位符
    if (targetVal === '?') {
      targetVal = (args[paramIndex] as string | number | null) ?? null;
      paramIndex++;
    } else if (targetVal.match(/^@\w+/)) {
      const name = targetVal.replace(/^@/, '');
      if (
        args.length === 1 &&
        typeof args[0] === 'object' &&
        !Array.isArray(args[0])
      ) {
        const obj = args[0] as Record<string, unknown>;
        targetVal = (obj[name] ?? obj[`@${name}`]) as string | number | null;
      } else {
        targetVal = (args[paramIndex] as string | number | null) ?? null;
        paramIndex++;
      }
    } else if (targetVal.startsWith("'") && targetVal.endsWith("'")) {
      targetVal = targetVal.slice(1, -1);
    } else if (!isNaN(Number(targetVal))) {
      targetVal = Number(targetVal);
    }

    let colIdx: number;
    try {
      colIdx = table.getColIndex(col);
    } catch {
      continue; // 跳过无效列名
    }

    rows = rows.filter((row) => {
      const cellVal = row[colIdx];
      switch (op) {
        case '=':
          return cellVal === targetVal;
        case '!=':
        case '<>':
          return cellVal !== targetVal;
        case '>=':
          return (cellVal ?? 0) >= (targetVal ?? 0);
        case '<=':
          return (cellVal ?? 0) <= (targetVal ?? 0);
        case '>':
          return (cellVal ?? 0) > (targetVal ?? 0);
        case '<':
          return (cellVal ?? 0) < (targetVal ?? 0);
        default:
          return true;
      }
    });
  }

  return rows;
}

function sortRows(
  rows: (string | number | null)[][],
  table: MemoryTable,
  orderClause: string
): (string | number | null)[][] {
  const m = orderClause.match(/(\w+)\s*(DESC|ASC)?/i);
  if (!m) return rows;
  const colIdx = table.getColIndex(m[1]);
  const desc = m[2]?.toUpperCase() === 'DESC';
  return [...rows].sort((a, b) => {
    const valA = a[colIdx];
    const valB = b[colIdx];
    if (valA == null && valB == null) return 0;
    if (valA == null) return 1;
    if (valB == null) return -1;
    const cmp = String(valA) > String(valB) ? 1 : -1;
    return desc ? -cmp : cmp;
  });
}

function rowsToObjects(
  rows: (string | number | null)[][],
  table: MemoryTable,
  selectExpr: string
): Record<string, unknown>[] {
  const allCols = selectExpr === '*' || selectExpr === 'DISTINCT *';
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < table.columns.length; i++) {
      if (allCols || selectExpr.includes(table.columns[i])) {
        obj[table.columns[i]] = row[i] ?? null;
      }
    }
    return obj;
  });
}

export default MemoryDatabase;
