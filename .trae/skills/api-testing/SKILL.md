---
name: 'api-testing'
description: 'Test API endpoints, validate responses, and ensure API reliability. Invoke when user needs to test APIs, validate endpoints, or debug API issues.'
---

# API Testing

This skill helps test and validate API endpoints.

## When to Use

- Testing new API endpoints
- Validating API responses
- Debugging API issues
- Checking API performance
- Testing authentication/authorization
- Validating data formats

## Testing Methods

### 1. Manual Testing with curl

```bash
# GET request
curl -X GET http://localhost:3111/api/users

# POST request with JSON body
curl -X POST http://localhost:3111/api/users \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@example.com"}'

# PUT request
curl -X PUT http://localhost:3111/api/users/1 \
  -H "Content-Type: application/json" \
  -d '{"username":"updated"}'

# DELETE request
curl -X DELETE http://localhost:3111/api/users/1

# With authentication
curl -X GET http://localhost:3111/api/protected \
  -H "Authorization: Bearer YOUR_TOKEN"

# With headers
curl -X GET http://localhost:3111/api/data \
  -H "Content-Type: application/json" \
  -H "Accept: application/json"
```

### 2. Using Postman/Thunder Client

Create test collections:

```json
{
  "info": {
    "name": "Jiabaixing API Tests",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Get Users",
      "request": {
        "method": "GET",
        "header": [],
        "url": {
          "raw": "http://localhost:3111/api/users",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3111",
          "path": ["api", "users"]
        }
      }
    }
  ]
}
```

### 3. Automated Testing with Jest

```typescript
// tests/api/users.test.ts
import request from 'supertest';
import app from '../../src/server/app';

describe('User API', () => {
  describe('GET /api/users', () => {
    it('should return all users', async () => {
      const response = await request(app)
        .get('/api/users')
        .expect('Content-Type', /json/)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('should return users with correct structure', async () => {
      const response = await request(app).get('/api/users').expect(200);

      if (response.body.length > 0) {
        const user = response.body[0];
        expect(user).toHaveProperty('id');
        expect(user).toHaveProperty('username');
        expect(user).toHaveProperty('email');
      }
    });
  });

  describe('POST /api/users', () => {
    it('should create a new user', async () => {
      const newUser = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123',
      };

      const response = await request(app)
        .post('/api/users')
        .send(newUser)
        .expect('Content-Type', /json/)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.username).toBe(newUser.username);
      expect(response.body.email).toBe(newUser.email);
      expect(response.body).not.toHaveProperty('password');
    });

    it('should validate required fields', async () => {
      const invalidUser = {
        username: '',
        email: 'invalid-email',
      };

      const response = await request(app)
        .post('/api/users')
        .send(invalidUser)
        .expect(400);

      expect(response.body).toHaveProperty('errors');
    });
  });

  describe('GET /api/users/:id', () => {
    it('should return user by ID', async () => {
      // First create a user
      const createResponse = await request(app).post('/api/users').send({
        username: 'getuser',
        email: 'get@example.com',
        password: 'password123',
      });

      const userId = createResponse.body.id;

      // Then get the user
      const response = await request(app)
        .get(`/api/users/${userId}`)
        .expect(200);

      expect(response.body.id).toBe(userId);
      expect(response.body.username).toBe('getuser');
    });

    it('should return 404 for non-existent user', async () => {
      const response = await request(app).get('/api/users/999999').expect(404);

      expect(response.body).toHaveProperty('error');
    });
  });
});
```

### 4. Testing Authentication

```typescript
describe('Authentication API', () => {
  let authToken: string;

  it('should register a new user', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'authuser',
        email: 'auth@example.com',
        password: 'securepass123',
      })
      .expect(201);

    expect(response.body).toHaveProperty('token');
    authToken = response.body.token;
  });

  it('should login with valid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'auth@example.com',
        password: 'securepass123',
      })
      .expect(200);

    expect(response.body).toHaveProperty('token');
    authToken = response.body.token;
  });

  it('should reject invalid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'auth@example.com',
        password: 'wrongpassword',
      })
      .expect(401);

    expect(response.body).toHaveProperty('error');
  });

  it('should access protected route with valid token', async () => {
    const response = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);
  });

  it('should reject protected route without token', async () => {
    const response = await request(app).get('/api/protected').expect(401);
  });
});
```

### 5. Testing File Uploads

```typescript
describe('File Upload API', () => {
  it('should upload a file', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('file', 'tests/fixtures/test-file.txt')
      .field('description', 'Test file')
      .expect(200);

    expect(response.body).toHaveProperty('filename');
    expect(response.body).toHaveProperty('url');
  });

  it('should validate file type', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('file', 'tests/fixtures/test-file.exe')
      .expect(400);

    expect(response.body).toHaveProperty('error');
  });
});
```

### 6. Testing Error Handling

```typescript
describe('Error Handling', () => {
  it('should handle malformed JSON', async () => {
    const response = await request(app)
      .post('/api/users')
      .set('Content-Type', 'application/json')
      .send('{invalid json}')
      .expect(400);
  });

  it('should handle missing fields', async () => {
    const response = await request(app).post('/api/users').send({}).expect(400);

    expect(response.body).toHaveProperty('errors');
  });

  it('should handle server errors gracefully', async () => {
    const response = await request(app).get('/api/error').expect(500);

    expect(response.body).toHaveProperty('error');
  });
});
```

### 7. Performance Testing

```typescript
describe('API Performance', () => {
  it('should respond within acceptable time', async () => {
    const start = Date.now();

    await request(app).get('/api/users').expect(200);

    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000); // 1 second
  });

  it('should handle concurrent requests', async () => {
    const requests = Array(10)
      .fill(null)
      .map(() => request(app).get('/api/users'));

    const responses = await Promise.all(requests);

    responses.forEach((response) => {
      expect(response.status).toBe(200);
    });
  });
});
```

### 8. Run Tests

```bash
# Run all API tests
npm test -- tests/api

# Run specific test file
npm test -- tests/api/users.test.ts

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch
```

## Tools to Use

- **Read**: Read API endpoint code
- **SearchCodebase**: Find related endpoints
- **Grep**: Search for API routes
- **RunCommand**: Run tests, start server
- **Write**: Create test files

## Best Practices

- Test all HTTP methods
- Validate response structure
- Test error scenarios
- Check authentication/authorization
- Test with various data types
- Test edge cases
- Measure performance
- Keep tests independent
- Use descriptive test names
- Mock external dependencies
