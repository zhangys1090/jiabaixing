---
name: 'frontend-backend-integration'
description: 'Test and debug frontend-backend integration, verify API communication, and resolve data flow issues. Invoke when testing full-stack features, API integration, or data synchronization.'
---

# Frontend-Backend Integration

This skill helps test and debug frontend-backend integration.

## When to Use

- Testing API communication between frontend and backend
- Debugging data flow issues
- Verifying WebSocket connections
- Testing authentication flows
- Checking real-time updates
- Resolving CORS issues
- Testing file uploads/downloads

## Integration Testing Process

### 1. API Communication Testing

```typescript
// Frontend test
describe('API Integration', () => {
  it('should fetch data from backend', async () => {
    const response = await fetch('http://localhost:3111/api/data');
    const data = await response.json();

    expect(response.ok).toBe(true);
    expect(data).toHaveProperty('success');
  });

  it('should handle errors gracefully', async () => {
    try {
      await fetch('http://localhost:3111/api/nonexistent');
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});
```

### 2. WebSocket Connection Testing

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
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'updates' }));
  });

  it('should handle connection errors', (done) => {
    ws.onerror = (error) => {
      expect(error).toBeDefined();
      done();
    };

    // Close connection to trigger error
    ws.close();
  });
});
```

### 3. Authentication Flow Testing

```typescript
describe('Authentication Integration', () => {
  it('should complete login flow', async () => {
    // Frontend: Login request
    const loginResponse = await fetch('http://localhost:3111/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    });

    const loginData = await loginResponse.json();
    expect(loginData.success).toBe(true);
    expect(loginData.token).toBeDefined();

    // Use token for authenticated request
    const protectedResponse = await fetch(
      'http://localhost:3111/api/protected',
      {
        headers: {
          Authorization: `Bearer ${loginData.token}`,
        },
      }
    );

    expect(protectedResponse.ok).toBe(true);
  });
});
```

### 4. Data Synchronization Testing

```typescript
describe('Data Synchronization', () => {
  it('should sync data between frontend and backend', async () => {
    // Create data on frontend
    const createResponse = await fetch('http://localhost:3111/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Item', value: 100 }),
    });

    const createdItem = await createResponse.json();

    // Fetch data on frontend
    const fetchResponse = await fetch('http://localhost:3111/api/items');
    const items = await fetchResponse.json();

    const found = items.data.find(
      (item: any) => item.id === createdItem.data.id
    );
    expect(found).toBeDefined();
    expect(found.name).toBe('Test Item');
  });
});
```

### 5. File Upload Testing

```typescript
describe('File Upload Integration', () => {
  it('should upload file successfully', async () => {
    const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('http://localhost:3111/api/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    expect(response.ok).toBe(true);
    expect(data.filename).toBeDefined();
  });
});
```

### 6. Real-time Updates Testing

```typescript
describe('Real-time Updates', () => {
  it('should receive updates via WebSocket', (done) => {
    const ws = new WebSocket('ws://localhost:3111/ws');

    ws.onopen = () => {
      // Subscribe to updates
      ws.send(JSON.stringify({ action: 'subscribe', channel: 'data' }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'update') {
        expect(data.payload).toBeDefined();
        ws.close();
        done();
      }
    };

    // Trigger an update on backend
    setTimeout(() => {
      fetch('http://localhost:3111/api/trigger-update', {
        method: 'POST',
      });
    }, 100);
  });
});
```

## Common Issues & Solutions

### CORS Issues

```typescript
// Backend: Configure CORS
app.use(
  cors({
    origin: ['http://localhost:3100'],
    credentials: true,
  })
);

// Frontend: Include credentials
fetch('http://localhost:3111/api/data', {
  credentials: 'include',
});
```

### WebSocket Connection Issues

```typescript
// Backend: Handle WebSocket connections
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Frontend: Handle reconnection
const ws = new WebSocket('ws://localhost:3111/ws');
ws.onclose = () => {
  setTimeout(() => {
    // Reconnect after 5 seconds
    const newWs = new WebSocket('ws://localhost:3111/ws');
  }, 5000);
};
```

### Authentication Token Issues

```typescript
// Frontend: Store and use token
const login = async (email: string, password: string) => {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const data = await response.json();
  localStorage.setItem('token', data.token);
  return data;
};

// Use token in requests
const authenticatedFetch = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem('token');
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
};
```

## Tools to Use

- **Read**: Read integration code
- **SearchCodebase**: Find API endpoints
- **Grep**: Search for API calls
- **RunCommand**: Start servers, run tests
- **Write**: Create integration tests

## Best Practices

- Test both success and error cases
- Verify data consistency
- Check authentication flows
- Test real-time features
- Monitor performance
- Handle network errors
- Test with different browsers
- Validate data formats
