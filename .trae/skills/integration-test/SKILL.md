---
name: 'integration-test'
description: 'Create and run integration tests for full system workflows, test API endpoints, and verify component interactions. Invoke when user needs to test complete features, API integration, or system workflows.'
---

# Integration Test

This skill helps create and run integration tests for the complete system.

## When to Use

- Testing complete user workflows
- Verifying API endpoints work correctly
- Testing component interactions
- Validating database operations
- Testing authentication flows
- Verifying WebSocket connections
- Testing file upload/download

## Testing Process

### 1. Identify Test Scenario

Determine what needs to be tested:

- What is the user workflow?
- Which components are involved?
- What are the expected outcomes?
- What edge cases should be covered?

### 2. Set Up Test Environment

```typescript
// tests/integration/user-workflow.test.ts
import request from 'supertest';
import app from '../../src/server/app';
import { Database } from 'better-sqlite3';

describe('User Workflow Integration Tests', () => {
  let db: Database;

  beforeAll(() => {
    // Setup test database
    db = new Database(':memory:');
    // Run migrations
  });

  afterAll(() => {
    // Cleanup
    db.close();
  });

  beforeEach(() => {
    // Reset database state
    db.exec('DELETE FROM users');
  });
});
```

### 3. Test API Endpoints

```typescript
describe('User API', () => {
  it('should create a new user', async () => {
    const response = await request(app)
      .post('/api/users')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      })
      .expect(201);

    expect(response.body).toHaveProperty('id');
    expect(response.body.username).toBe('testuser');
  });

  it('should get user by ID', async () => {
    // First create a user
    const createResponse = await request(app).post('/api/users').send({
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
    });

    const userId = createResponse.body.id;

    // Then get the user
    const response = await request(app).get(`/api/users/${userId}`).expect(200);

    expect(response.body.username).toBe('testuser');
  });
});
```

### 4. Test Complete Workflows

```typescript
describe('Complete User Registration Flow', () => {
  it('should complete full registration process', async () => {
    // Step 1: Register user
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'newuser',
        email: 'new@example.com',
        password: 'securepass123',
      })
      .expect(201);

    expect(registerResponse.body).toHaveProperty('token');

    // Step 2: Login with credentials
    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'new@example.com',
        password: 'securepass123',
      })
      .expect(200);

    const token = loginResponse.body.token;

    // Step 3: Access protected route
    const protectedResponse = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(protectedResponse.body.email).toBe('new@example.com');
  });
});
```

### 5. Test Database Operations

```typescript
describe('Database Integration', () => {
  it('should persist data correctly', async () => {
    // Insert data
    await request(app)
      .post('/api/items')
      .send({ name: 'Test Item', value: 100 })
      .expect(201);

    // Verify in database
    const item = db
      .prepare('SELECT * FROM items WHERE name = ?')
      .get('Test Item');
    expect(item).toBeDefined();
    expect(item.value).toBe(100);
  });

  it('should handle transactions correctly', async () => {
    // Test rollback on error
    const response = await request(app)
      .post('/api/transaction')
      .send({
        items: [
          { name: 'Item 1', value: 100 },
          { name: 'Item 2', value: 200 },
          { name: 'Invalid Item', value: 'invalid' },
        ],
      });

    // Should fail
    expect(response.status).toBe(400);

    // No items should be inserted
    const count = db.prepare('SELECT COUNT(*) as count FROM items').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});
```

### 6. Test WebSocket Connections

```typescript
describe('WebSocket Integration', () => {
  let ws: WebSocket;

  beforeEach((done) => {
    ws = new WebSocket('ws://localhost:3111/ws');
    ws.onopen = done;
  });

  afterEach(() => {
    ws.close();
  });

  it('should receive real-time updates', (done) => {
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      expect(data.type).toBe('update');
      done();
    };

    // Trigger an update
    request(app).post('/api/trigger-update').send({ message: 'test' });
  });
});
```

### 7. Test Error Scenarios

```typescript
describe('Error Handling', () => {
  it('should handle invalid input', async () => {
    const response = await request(app)
      .post('/api/users')
      .send({
        username: '', // Invalid
        email: 'invalid-email', // Invalid
        password: '123', // Too short
      })
      .expect(400);

    expect(response.body).toHaveProperty('errors');
  });

  it('should handle not found errors', async () => {
    const response = await request(app).get('/api/users/999999').expect(404);

    expect(response.body.error).toContain('not found');
  });
});
```

### 8. Run Tests

```bash
# Run all integration tests
npm run test:integration

# Run specific test file
npm test -- tests/integration/user-workflow.test.ts

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch
```

## Tools to Use

- **Read**: Read test files
- **SearchCodebase**: Find existing tests
- **Grep**: Search for test patterns
- **RunCommand**: Run tests
- **Write**: Create new test files

## Best Practices

- Test complete workflows, not just units
- Use realistic test data
- Clean up after each test
- Test both success and failure cases
- Use descriptive test names
- Keep tests independent
- Mock external dependencies
- Test edge cases
