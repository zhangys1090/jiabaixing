/**
 * 诊断测试：确认 jest 环境下 DatabaseShim 使用哪种数据库
 */
import { createDatabase } from '../../src/shared/DatabaseShim';

describe('DatabaseShim 诊断', () => {
  test('确认数据库类型', () => {
    const db = createDatabase(':memory:');
    const dbType = db.constructor?.name || typeof db;
    console.log('DB_TYPE:', dbType);
    console.log('DB_HAS_TABLES:', !!db.tables);
    console.log('DB_METHODS:', Object.keys(db));

    db.exec('CREATE TABLE IF NOT EXISTS test_table (id TEXT, val TEXT);');
    console.log('AFTER_EXEC_TABLES:', db.tables ? Array.from(db.tables.keys()) : 'N/A');

    const stmt = db.prepare('INSERT INTO test_table (id, val) VALUES (@id, @val)');
    const runResult = stmt.run({ id: '1', val: 'hello' });
    console.log('INSERT_RESULT:', runResult);

    const allStmt = db.prepare('SELECT * FROM test_table');
    const allResult = allStmt.all();
    console.log('ALL_ROWS:', JSON.stringify(allResult));

    const countStmt = db.prepare('SELECT COUNT(*) as count FROM test_table');
    console.log('COUNT_STMT_TYPE:', countStmt.parsed?.type);
    console.log('COUNT_STMT_AGGFN:', countStmt.parsed?.aggFn);
    console.log('COUNT_STMT_ALIAS:', countStmt.parsed?.alias);
    console.log('COUNT_STMT_TABLE:', countStmt.parsed?.tableName);
    const countResult = countStmt.get();
    console.log('COUNT_RESULT:', JSON.stringify(countResult));

    db.close();
  });
});