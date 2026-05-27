---
name: 'database-debug'
description: 'Debug database issues, optimize queries, and fix data problems. Invoke when user reports database errors, slow queries, or data inconsistencies.'
---

# Database Debug

This skill helps debug and fix database issues.

## When to Use

- Database connection errors
- Slow query performance
- Data inconsistencies
- Migration issues
- Query errors
- Data corruption
- Transaction problems

## Debugging Process

### 1. Check Database Connection

```typescript
// Test database connection
import Database from 'better-sqlite3';

try {
  const db = new Database('path/to/database.sqlite');
  const result = db.prepare('SELECT 1').get();
  console.log('Database connected:', result);
  db.close();
} catch (error) {
  console.error('Database connection failed:', error);
}
```

### 2. Examine Database Schema

```typescript
// List all tables
const tables = db
  .prepare(
    `
  SELECT name FROM sqlite_master
  WHERE type='table'
  ORDER BY name
`
  )
  .all();

console.log('Tables:', tables);

// Get table schema
const schema = db.prepare(`PRAGMA table_info(table_name)`).all();
console.log('Schema:', schema);

// Get indexes
const indexes = db.prepare(`PRAGMA index_list(table_name)`).all();
console.log('Indexes:', indexes);
```

### 3. Inspect Data

```typescript
// Count rows
const count = db.prepare('SELECT COUNT(*) as count FROM table_name').get();
console.log('Row count:', count);

// Sample data
const sample = db.prepare('SELECT * FROM table_name LIMIT 10').all();
console.log('Sample data:', sample);

// Check for duplicates
const duplicates = db
  .prepare(
    `
  SELECT column_name, COUNT(*) as count
  FROM table_name
  GROUP BY column_name
  HAVING count > 1
`
  )
  .all();

console.log('Duplicates:', duplicates);
```

### 4. Common Issues & Solutions

#### Connection Issues

```typescript
// Problem: Database locked
// Solution: Enable WAL mode
db.pragma('journal_mode = WAL');

// Problem: Multiple connections
// Solution: Use connection pool or singleton
class DatabaseManager {
  private static instance: Database.Database;

  static getInstance(): Database.Database {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new Database('path/to/db.sqlite');
      DatabaseManager.instance.pragma('journal_mode = WAL');
    }
    return DatabaseManager.instance;
  }
}
```

#### Slow Queries

```typescript
// Problem: Full table scan
// Bad
const result = db
  .prepare(
    `
  SELECT * FROM large_table
  WHERE name LIKE '%search%'
`
  )
  .all();

// Good: Use indexes
db.prepare('CREATE INDEX IF NOT EXISTS idx_name ON large_table(name)').run();

// Or use full-text search
db.prepare(
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS large_table_fts
  USING fts5(name, content='large_table', content_rowid='id')
`
).run();

const result = db
  .prepare(
    `
  SELECT * FROM large_table
  WHERE id IN (
    SELECT rowid FROM large_table_fts
    WHERE large_table_fts MATCH 'search'
  )
`
  )
  .all();
```

#### N+1 Query Problem

```typescript
// Problem: N+1 queries
// Bad
const users = db.prepare('SELECT * FROM users').all();
for (const user of users) {
  const posts = db
    .prepare('SELECT * FROM posts WHERE user_id = ?')
    .all(user.id);
  user.posts = posts;
}

// Good: Use JOIN
const usersWithPosts = db
  .prepare(
    `
  SELECT
    users.*,
    posts.id as post_id,
    posts.title as post_title
  FROM users
  LEFT JOIN posts ON users.id = posts.user_id
`
  )
  .all();

// Group results
const usersMap = new Map();
for (const row of usersWithPosts) {
  if (!usersMap.has(row.id)) {
    usersMap.set(row.id, {
      id: row.id,
      name: row.name,
      posts: [],
    });
  }

  if (row.post_id) {
    usersMap.get(row.id).posts.push({
      id: row.post_id,
      title: row.post_title,
    });
  }
}

const users = Array.from(usersMap.values());
```

#### Transaction Issues

```typescript
// Problem: Partial updates on error
// Bad
try {
  db.prepare('UPDATE accounts SET balance = balance - 100 WHERE id = 1').run();
  db.prepare('UPDATE accounts SET balance = balance + 100 WHERE id = 2').run();
} catch (error) {
  console.error(error);
}

// Good: Use transactions
const transfer = db.transaction(
  (fromId: number, toId: number, amount: number) => {
    db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(
      amount,
      fromId
    );
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(
      amount,
      toId
    );
  }
);

try {
  transfer(1, 2, 100);
} catch (error) {
  console.error('Transfer failed:', error);
}
```

#### Data Type Issues

```typescript
// Problem: Incorrect data types
// Check and fix
const rows = db.prepare('SELECT * FROM table_name').all();
for (const row of rows) {
  if (typeof row.numeric_field !== 'number') {
    console.log('Invalid type:', row.id, row.numeric_field);
  }
}

// Fix with proper types
db.prepare(
  `
  UPDATE table_name
  SET numeric_field = CAST(numeric_field AS REAL)
  WHERE typeof(numeric_field) != 'real'
`
).run();
```

### 5. Performance Optimization

```typescript
// Analyze query performance
const queries = [
  'SELECT * FROM users WHERE email = ?',
  'SELECT * FROM posts ORDER BY created_at DESC LIMIT 10',
  'SELECT COUNT(*) FROM comments WHERE post_id = ?',
];

for (const query of queries) {
  const start = Date.now();
  db.prepare(query).all();
  const duration = Date.now() - start;
  console.log(`${query} took ${duration}ms`);
}

// Create indexes for slow queries
db.prepare('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)').run();
db.prepare(
  'CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)'
).run();
db.prepare(
  'CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)'
).run();

// Analyze query plan
const plan = db
  .prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE email = ?')
  .all();
console.log('Query plan:', plan);
```

### 6. Data Integrity

```typescript
// Check foreign key constraints
db.pragma('foreign_keys = ON');

// Find orphaned records
const orphans = db
  .prepare(
    `
  SELECT child.id
  FROM child_table child
  LEFT JOIN parent_table parent ON child.parent_id = parent.id
  WHERE parent.id IS NULL
`
  )
  .all();

console.log('Orphaned records:', orphans);

// Fix orphaned records
db.prepare(
  'DELETE FROM child_table WHERE parent_id NOT IN (SELECT id FROM parent_table)'
).run();

// Validate data
const validation = db
  .prepare(
    `
  SELECT * FROM table_name
  WHERE required_field IS NULL
    OR email_field NOT LIKE '%@%.%'
    OR numeric_field < 0
`
  )
  .all();

console.log('Invalid records:', validation);
```

### 7. Backup and Recovery

```typescript
// Create backup
import fs from 'fs';

function backupDatabase(sourcePath: string, backupPath: string) {
  const data = fs.readFileSync(sourcePath);
  fs.writeFileSync(backupPath, data);
  console.log('Database backed up to:', backupPath);
}

// Restore database
function restoreDatabase(backupPath: string, targetPath: string) {
  const data = fs.readFileSync(backupPath);
  fs.writeFileSync(targetPath, data);
  console.log('Database restored from:', backupPath);
}

// Export data
function exportTable(
  db: Database.Database,
  tableName: string,
  outputPath: string
) {
  const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
  fs.writeFileSync(outputPath, JSON.stringify(rows, null, 2));
  console.log(`Exported ${rows.length} rows from ${tableName}`);
}
```

### 8. Monitoring

```typescript
// Monitor database operations
class DatabaseMonitor {
  private queryCount = 0;
  private queryTimes: number[] = [];

  logQuery(duration: number) {
    this.queryCount++;
    this.queryTimes.push(duration);

    if (this.queryCount % 100 === 0) {
      const avg =
        this.queryTimes.reduce((a, b) => a + b, 0) / this.queryTimes.length;
      const max = Math.max(...this.queryTimes);
      console.log(
        `Queries: ${this.queryCount}, Avg: ${avg.toFixed(2)}ms, Max: ${max}ms`
      );
    }
  }
}

const monitor = new DatabaseMonitor();

// Wrap queries
function executeQuery(db: Database.Database, query: string, params?: any[]) {
  const start = Date.now();
  const result = db.prepare(query).all(...(params || []));
  const duration = Date.now() - start;
  monitor.logQuery(duration);
  return result;
}
```

## Tools to Use

- **Read**: Read database-related code
- **SearchCodebase**: Find database operations
- **Grep**: Search for SQL queries
- **RunCommand**: Run database scripts
- **Write**: Create migration files

## Best Practices

- Always use parameterized queries
- Enable foreign key constraints
- Use transactions for multi-step operations
- Create appropriate indexes
- Regularly backup database
- Monitor query performance
- Validate data integrity
- Handle connection errors
- Use connection pooling
- Document schema changes
