---
name: 'performance-opt'
description: 'Optimize application performance, identify bottlenecks, and improve response times. Invoke when user reports slow performance, high memory usage, or needs performance improvements.'
---

# Performance Optimization

This skill helps optimize application performance and identify bottlenecks.

## When to Use

- Application is slow or unresponsive
- High memory usage
- Long API response times
- Slow database queries
- UI rendering performance issues
- Need to optimize specific features

## Optimization Process

### 1. Identify Performance Issues

First, identify what's slow:

```bash
# Check CPU and memory usage
# Use Task Manager or Process Explorer

# Monitor API response times
# Check browser Network tab

# Check database query times
# Add logging to measure query duration
```

### 2. Profile the Application

Use profiling tools:

```typescript
// Add performance logging
console.time('operation');
// ... code to measure
console.timeEnd('operation');

// Or use performance API
const start = performance.now();
// ... code
const duration = performance.now() - start;
console.log(`Operation took ${duration}ms`);
```

### 3. Common Bottlenecks & Solutions

#### Slow Database Queries

```typescript
// Problem: N+1 query problem
// Bad
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
  SELECT users.*, posts.*
  FROM users
  LEFT JOIN posts ON users.id = posts.user_id
`
  )
  .all();

// Or use prepared statements
const getPosts = db.prepare('SELECT * FROM posts WHERE user_id = ?');
for (const user of users) {
  user.posts = getPosts.all(user.id);
}
```

#### Inefficient API Calls

```typescript
// Problem: Multiple sequential API calls
// Bad
const user1 = await fetchUser(1);
const user2 = await fetchUser(2);
const user3 = await fetchUser(3);

// Good: Parallel calls
const [user1, user2, user3] = await Promise.all([
  fetchUser(1),
  fetchUser(2),
  fetchUser(3),
]);
```

#### Memory Leaks

```typescript
// Problem: Not cleaning up event listeners
useEffect(() => {
  const handler = () => console.log('event');
  window.addEventListener('resize', handler);

  // Missing cleanup
  // return () => window.removeEventListener('resize', handler);
});

// Good: Always cleanup
useEffect(() => {
  const handler = () => console.log('event');
  window.addEventListener('resize', handler);

  return () => window.removeEventListener('resize', handler);
}, []);
```

#### Unnecessary Re-renders

```typescript
// Problem: Component re-renders unnecessarily
const MyComponent = ({ items }) => {
  const [value, setValue] = useState('');

  // This re-renders on every value change
  const processedItems = items.map(item => ({
    ...item,
    processed: item.value * 2
  }));

  return <div>{/* ... */}</div>;
};

// Good: Use useMemo
const MyComponent = ({ items }) => {
  const [value, setValue] = useState('');

  const processedItems = useMemo(() =>
    items.map(item => ({
      ...item,
      processed: item.value * 2
    })),
    [items]
  );

  return <div>{/* ... */}</div>;
};
```

### 4. Frontend Performance

#### Code Splitting

```typescript
// Lazy load components
const HeavyComponent = React.lazy(() => import('./HeavyComponent'));

// Use Suspense
<Suspense fallback={<Loading />}>
  <HeavyComponent />
</Suspense>
```

#### Virtual Scrolling

```typescript
// Use react-window for long lists
import { FixedSizeList as List } from 'react-window';

const Row = ({ index, style }) => (
  <div style={style}>Row {index}</div>
);

<List
  height={400}
  itemCount={1000}
  itemSize={35}
  width={300}
>
  {Row}
</List>
```

#### Image Optimization

```typescript
// Use lazy loading
<img src="image.jpg" loading="lazy" alt="description" />

// Use appropriate formats
// WebP for modern browsers
// Fallback to JPEG/PNG
```

### 5. Backend Performance

#### Caching

```typescript
// Implement caching
const cache = new Map();

const getCachedData = async (key: string, fetcher: () => Promise<any>) => {
  if (cache.has(key)) {
    return cache.get(key);
  }

  const data = await fetcher();
  cache.set(key, data);
  return data;
};

// Use with TTL
const cacheWithTTL = new Map<string, { data: any; expiry: number }>();

const getWithTTL = async (
  key: string,
  ttl: number,
  fetcher: () => Promise<any>
) => {
  const cached = cacheWithTTL.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }

  const data = await fetcher();
  cacheWithTTL.set(key, { data, expiry: Date.now() + ttl });
  return data;
};
```

#### Connection Pooling

```typescript
// Reuse database connections
class DatabasePool {
  private static instance: Database;

  static getInstance(): Database {
    if (!DatabasePool.instance) {
      DatabasePool.instance = new Database('path/to/db.sqlite');
      DatabasePool.instance.pragma('journal_mode = WAL');
    }
    return DatabasePool.instance;
  }
}
```

#### Request Debouncing

```typescript
// Debounce rapid requests
const debounce = (fn: Function, delay: number) => {
  let timeoutId: NodeJS.Timeout;
  return (...args: any[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};

const debouncedSearch = debounce(search, 300);
```

### 6. Monitoring & Metrics

```typescript
// Add performance monitoring
const metrics = {
  apiCalls: 0,
  totalResponseTime: 0,
  errors: 0,
};

app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.apiCalls++;
    metrics.totalResponseTime += duration;

    if (res.statusCode >= 400) {
      metrics.errors++;
    }

    console.log(`${req.method} ${req.path} - ${duration}ms`);
  });

  next();
});
```

### 7. Performance Testing

```bash
# Run performance tests
npm run test:performance

# Load testing with artillery
# Create load-test.yml
# Then run: artillery run load-test.yml

# Monitor during test
# - CPU usage
# - Memory usage
# - Response times
# - Error rates
```

## Tools to Use

- **Read**: Read code to identify bottlenecks
- **SearchCodebase**: Find similar patterns
- **Grep**: Search for performance issues
- **RunCommand**: Run performance tests
- **Write**: Add optimization code

## Best Practices

- Measure before optimizing
- Focus on the biggest bottlenecks
- Don't optimize prematurely
- Use caching wisely
- Clean up resources
- Monitor performance metrics
- Test optimizations
- Document changes
