---
name: 'backend-debug'
description: 'Debug Node.js/Express backend issues, fix API errors, and resolve server problems. Invoke when user reports backend bugs, API failures, or server errors.'
---

# Backend Debug

This skill helps debug and fix Node.js/Express backend issues.

## When to Use

- API endpoints returning errors
- Server crashes or hangs
- Database connection issues
- Authentication/authorization problems
- Performance issues in backend
- Middleware not working correctly
- WebSocket connection issues

## Debugging Process

### 1. Check Server Logs

Always start by checking server logs:

```bash
# Check logs directory
ls logs/

# View recent logs
tail -f logs/app.log

# Check for errors
grep -i error logs/app.log
```

### 2. Reproduce the Issue

Try to reproduce the error:

```bash
# Use curl to test API
curl -X GET http://localhost:3111/api/endpoint

# Or use Postman/Thunder Client
```

### 3. Examine the Code

Review the problematic endpoint/handler:

- Check route definition
- Verify middleware order
- Look for error handling
- Check async/await usage

### 4. Common Issues & Solutions

#### 500 Internal Server Error

```typescript
// Check for unhandled errors
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});
```

#### Async Errors Not Caught

```typescript
// Use try-catch in async handlers
app.get('/api/data', async (req, res, next) => {
  try {
    const data = await fetchData();
    res.json(data);
  } catch (error) {
    next(error); // Pass to error handler
  }
});
```

#### Database Connection Issues

```typescript
// Check database connection
const db = new Database('path/to/db.sqlite');
try {
  db.prepare('SELECT 1').get();
  console.log('Database connected');
} catch (error) {
  console.error('Database connection failed:', error);
}
```

#### CORS Issues

```typescript
// Configure CORS properly
app.use(
  cors({
    origin: ['http://localhost:3100'],
    credentials: true,
  })
);
```

### 5. Debug with VS Code

Use the VS Code debugger:

1. Set breakpoints in your code
2. Use "🚀 启动后端服务" launch configuration
3. Inspect variables and call stack
4. Step through code execution

### 6. Performance Issues

- Use performance monitoring
- Check database queries
- Look for memory leaks
- Profile with Node.js profiler

### 7. Testing Fixes

After fixing the issue:

1. Test the endpoint manually
2. Run integration tests
3. Check logs for errors
4. Verify with frontend

## Tools to Use

- **Read**: Read backend files
- **SearchCodebase**: Find related routes/handlers
- **Grep**: Search for error messages
- **RunCommand**: Start server, run tests
- **CheckCommandStatus**: Check running processes

## Example Workflow

User: "The login API is returning 500 error"

1. Check server logs for the error
2. Find the login route handler
3. Examine the code for issues
4. Test the endpoint with curl
5. Fix the issue (e.g., missing error handling)
6. Test the fix

## Best Practices

- Always check logs first
- Use proper error handling
- Validate input data
- Log important events
- Add comprehensive tests
- Document API endpoints
