/**
 * better-sqlite3 模拟实现
 * 用于单元测试，避免真实的 SQLite 依赖
 */

interface WhereCondition {
  column: string;
  operator: string;
  value: string | number | null | '?';
  paramIndex?: number;
}

class MockStatement {
  private sql: string;
  private tableStore: Map<string, any[]>;
  private tableName: string;
  private isSelect: boolean;
  private isInsert: boolean;
  private isUpdate: boolean;
  private isDelete: boolean;
  private isCountQuery: boolean;
  private isAvgQuery: boolean;
  private isGroupByQuery: boolean;
  private groupByColumn: string | null;
  private whereConditions: WhereCondition[];

  constructor(sql: string, tableStore: Map<string, any[]>) {
    this.sql = sql;
    this.tableStore = tableStore;
    this.isSelect = /^\s*SELECT/i.test(sql);
    this.isInsert = /^\s*INSERT/i.test(sql);
    this.isUpdate = /^\s*UPDATE/i.test(sql);
    this.isDelete = /^\s*DELETE/i.test(sql);
    this.isCountQuery = /COUNT\s*\(/i.test(sql);
    this.isAvgQuery = /AVG\s*\(/i.test(sql);
    this.isGroupByQuery = /GROUP\s+BY/i.test(sql);
    this.whereConditions = [];
    this.groupByColumn = null;

    const tableMatch = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    this.tableName = tableMatch ? tableMatch[1] : 'unknown';

    const groupByMatch = sql.match(/GROUP\s+BY\s+(\w+)/i);
    if (groupByMatch) {
      this.groupByColumn = groupByMatch[1];
    }

    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s*$)/i);
    if (whereMatch) {
      this.parseWhereClause(whereMatch[1]);
    }
  }

  private parseWhereClause(clause: string): void {
    const parts = clause.split(/\s+AND\s+/i);
    for (const part of parts) {
      const eqMatch = part.match(/(\w+)\s*=\s*'([^']*)'/);
      if (eqMatch) {
        this.whereConditions.push({ column: eqMatch[1], operator: '=', value: eqMatch[2] });
        continue;
      }
      const paramEqMatch = part.match(/(\w+)\s*=\s*@(\w+)/);
      if (paramEqMatch) {
        this.whereConditions.push({ column: paramEqMatch[1], operator: '=param', value: paramEqMatch[2] });
        continue;
      }
      const questionParamMatch = part.match(/(\w+)\s*=\s*\?/);
      if (questionParamMatch) {
        this.whereConditions.push({ column: questionParamMatch[1], operator: '=?', value: '?', paramIndex: this.whereConditions.length });
        continue;
      }
      const gtMatch = part.match(/(\w+)\s*>\s*(\d+)/);
      if (gtMatch) {
        this.whereConditions.push({ column: gtMatch[1], operator: '>', value: parseInt(gtMatch[2], 10) });
        continue;
      }
      const gteMatch = part.match(/(\w+)\s*>=\s*(\d+)/);
      if (gteMatch) {
        this.whereConditions.push({ column: gteMatch[1], operator: '>=', value: parseInt(gteMatch[2], 10) });
        continue;
      }
      const ltMatch = part.match(/(\w+)\s*<\s*(\d+)/);
      if (ltMatch) {
        this.whereConditions.push({ column: ltMatch[1], operator: '<', value: parseInt(ltMatch[2], 10) });
        continue;
      }
      const notNullMatch = part.match(/(\w+)\s+IS\s+NOT\s+NULL/i);
      if (notNullMatch) {
        this.whereConditions.push({ column: notNullMatch[1], operator: 'IS NOT NULL', value: null });
        continue;
      }
    }
  }

  private getParamValue(value: any, paramIndex: number): any {
    if (Array.isArray(value)) {
      return value[paramIndex] ?? undefined;
    }
    return value;
  }

  private filterData(data: any[], params?: any): any[] {
    let filtered = [...data];
    for (const cond of this.whereConditions) {
      filtered = filtered.filter(row => {
        switch (cond.operator) {
          case '=':
            return row[cond.column] === cond.value;
          case '=param': {
            if (cond.value === null) return true;
            const paramKey = cond.value as string;
            const targetVal = typeof params === 'object' && params !== null ? params[paramKey] : undefined;
            return targetVal === undefined || row[cond.column] === targetVal;
          }
          case '=?': {
            const paramValue = cond.paramIndex !== undefined ? this.getParamValue(params, cond.paramIndex) : undefined;
            return paramValue === undefined || row[cond.column] === paramValue;
          }
          case '>':
            return (row[cond.column] ?? 0) > (cond.value ?? 0);
          case '>=':
            return (row[cond.column] ?? 0) >= (cond.value ?? 0);
          case '<':
            return (row[cond.column] ?? 0) < (cond.value ?? 0);
          case 'IS NOT NULL':
            return row[cond.column] !== null && row[cond.column] !== undefined;
          default:
            return true;
        }
      });
    }
    return filtered;
  }

  run(params: any): { lastInsertRowid: number; changes: number } {
    if (!this.tableStore.has(this.tableName)) {
      this.tableStore.set(this.tableName, []);
    }
    const data = this.tableStore.get(this.tableName)!;

    if (this.isInsert) {
      const record = typeof params === 'object' && params !== null
        ? { ...params }
        : { id: data.length + 1 };
      if (!record.id) {
        record.id = data.length + 1;
      }
      data.push(record);
      return { lastInsertRowid: record.id || data.length, changes: 1 };
    }

    if (this.isUpdate) {
      let changes = 0;
      const filtered = this.filterData(data, params);
      for (const row of filtered) {
        Object.assign(row, typeof params === 'object' ? params : {});
        changes++;
      }
      return { lastInsertRowid: 0, changes };
    }

    if (this.isDelete) {
      const before = data.length;
      const newData = this.filterData(data, params);
      const removed = before - newData.length;
      this.tableStore.set(this.tableName, newData);
      return { lastInsertRowid: 0, changes: removed };
    }

    return { lastInsertRowid: 0, changes: 0 };
  }

  all(params?: any): any[] {
    if (!this.tableStore.has(this.tableName)) {
      if (this.isCountQuery) return [{ count: 0 }];
      if (this.isAvgQuery) return [{ avg: null }];
      return [];
    }
    const data = this.tableStore.get(this.tableName)!;
    const filtered = this.filterData(data, params);

    if (this.isGroupByQuery && this.groupByColumn) {
      const groups = new Map<any, any[]>();
      for (const row of filtered) {
        const key = row[this.groupByColumn];
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(row);
      }

      const results: any[] = [];
      for (const [key, group] of groups.entries()) {
        const resultRow: any = { [this.groupByColumn]: key };
        
        if (this.isCountQuery) {
          resultRow.count = group.length;
        }
        
        results.push(resultRow);
      }

      if (/ORDER\s+BY\s+count/i.test(this.sql)) {
        results.sort((a, b) => b.count - a.count);
      }
      
      const limitMatch = this.sql.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) {
        return results.slice(0, parseInt(limitMatch[1], 10));
      }
      
      return results;
    }

    if (this.isCountQuery) {
      return [{ count: filtered.length }];
    }

    if (this.isAvgQuery) {
      const avgMatch = this.sql.match(/AVG\s*\(\s*(\w+)\s*\)/i);
      if (avgMatch) {
        const col = avgMatch[1];
        const values = filtered.map(r => r[col]).filter(v => v !== null && v !== undefined && v > 0);
        const avg = values.length > 0 ? values.reduce((a: number, b: number) => a + b, 0) / values.length : null;
        return [{ avg }];
      }
      return [{ avg: null }];
    }

    let result = [...filtered];

    const orderMatch = this.sql.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    if (orderMatch) {
      const col = orderMatch[1];
      const dir = (orderMatch[2] || 'ASC').toUpperCase();
      result.sort((a, b) => {
        const av = a[col] ?? 0;
        const bv = b[col] ?? 0;
        return dir === 'DESC' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
      });
    }

    const limitOffsetMatch = this.sql.match(/LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/i);
    if (limitOffsetMatch) {
      const limit = parseInt(limitOffsetMatch[1], 10);
      const offset = limitOffsetMatch[2] ? parseInt(limitOffsetMatch[2], 10) : 0;
      result = result.slice(offset, offset + limit);
    } else {
      const limitPlaceholderMatch = this.sql.match(/LIMIT\s+\?/i);
      if (limitPlaceholderMatch && typeof params === 'number') {
        result = result.slice(0, params);
      } else if (Array.isArray(params) && params.length >= 1) {
        const limitParam = params[0] as number;
        const offsetParam = params[1] as number;
        if (offsetParam !== undefined) {
          result = result.slice(offsetParam, offsetParam + limitParam);
        } else {
          result = result.slice(0, limitParam);
        }
      }
    }

    return result;
  }

  get(params?: any): any | undefined {
    const results = this.all(params);
    return results.length > 0 ? results[0] : undefined;
  }
}

class MockDatabase {
  private tableStore: Map<string, any[]>;

  constructor() {
    this.tableStore = new Map();
  }

  pragma(query: string): any {
    if (query.includes('table_info')) {
      return [{ name: 'id' }, { name: 'content' }, { name: 'trace_id' }];
    }
    return {};
  }

  exec(sql: string): void {
    return;
  }

  prepare(sql: string): MockStatement {
    return new MockStatement(sql, this.tableStore);
  }

  transaction<T extends (...args: any[]) => any>(fn: T): (...args: Parameters<T>) => ReturnType<T> {
    return (...args: Parameters<T>): ReturnType<T> => {
      try {
        return fn(...args);
      } catch (error) {
        throw error;
      }
    };
  }

  close(): void {
    return;
  }

  get open(): boolean {
    return true;
  }
}

function DatabaseConstructor(filePath: string): MockDatabase {
  return new MockDatabase();
}

export default DatabaseConstructor;
export { MockDatabase, MockStatement };
