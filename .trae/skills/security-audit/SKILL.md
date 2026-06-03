---
name: 'security-audit'
description: 'Perform security audits, fix vulnerabilities, and ensure application security. Invoke when user needs security checks, vulnerability fixes, or security best practices.'
---

# Security Audit

This skill helps perform security audits and fix vulnerabilities.

## When to Use

- Security vulnerability scanning
- Fixing security issues
- Implementing security best practices
- Authentication/authorization issues
- Data protection concerns
- Compliance requirements

## Security Checklist

### 1. Dependency Security

```bash
# Run security audit
npm audit

# Fix vulnerabilities automatically
npm audit fix

# Fix only production dependencies
npm audit fix --production

# Check for outdated packages
npm outdated

# Update dependencies
npm update

# Use Snyk for deeper analysis
npm run security:scan
npm run security:monitor
```

### 2. Code Security Review

#### Input Validation

```typescript
// Bad: No validation
app.post('/api/users', (req, res) => {
  const { username, email } = req.body;
  // Direct use of input
});

// Good: Validate input
import { body, validationResult } from 'express-validator';

app.post(
  '/api/users',
  [
    body('username')
      .trim()
      .isLength({ min: 3, max: 30 })
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage(
        'Username must be 3-30 characters and contain only letters, numbers, and underscores'
      ),
    body('email')
      .trim()
      .isEmail()
      .normalizeEmail()
      .withMessage('Invalid email address'),
    body('password')
      .isLength({ min: 8 })
      .matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/
      )
      .withMessage(
        'Password must be at least 8 characters and contain uppercase, lowercase, number, and special character'
      ),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Process validated input
  }
);
```

#### SQL Injection Prevention

```typescript
// Bad: String concatenation
const query = `SELECT * FROM users WHERE name = '${username}'`;
const user = db.prepare(query).get();

// Good: Parameterized queries
const query = 'SELECT * FROM users WHERE name = ?';
const user = db.prepare(query).get(username);

// Good: Named parameters
const query = 'SELECT * FROM users WHERE name = @name';
const user = db.prepare(query).get({ name: username });
```

#### XSS Prevention

```typescript
// Bad: Direct rendering
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  res.send(`<div>Results for: ${query}</div>`);
});

// Good: Escape output
import escape from 'escape-html';

app.get('/api/search', (req, res) => {
  const query = req.query.q;
  res.send(`<div>Results for: ${escape(query)}</div>`);
});

// Good: Use React (automatically escapes)
const SearchResults = ({ query }) => (
  <div>Results for: {query}</div>
);
```

#### CSRF Protection

```typescript
import csurf from 'csurf';
import cookieParser from 'cookie-parser';

app.use(cookieParser());
app.use(csurf({ cookie: true }));

// Include CSRF token in forms
app.get('/form', (req, res) => {
  res.send(`
    <form method="POST" action="/submit">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}">
      <input type="text" name="data">
      <button type="submit">Submit</button>
    </form>
  `);
});
```

### 3. Authentication & Authorization

#### Secure Password Storage

```typescript
import bcrypt from 'bcrypt';

const hashPassword = async (password: string): Promise<string> => {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
};

const verifyPassword = async (
  password: string,
  hash: string
): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

// Usage
const hashedPassword = await hashPassword('userPassword');
const isValid = await verifyPassword('userPassword', hashedPassword);
```

#### JWT Token Security

```typescript
import jwt from 'jsonwebtoken';

const generateToken = (userId: number): string => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '1h',
    issuer: 'jiabaixing',
    audience: 'jiabaixing-users',
  });
};

const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', {
      issuer: 'jiabaixing',
      audience: 'jiabaixing-users',
    });
  } catch (error) {
    throw new Error('Invalid token');
  }
};

// Middleware
const authenticate = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};
```

#### Role-Based Access Control

```typescript
const authorize = (...roles: string[]) => {
  return (req: any, res: any, next: any) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    next();
  };
};

// Usage
app.get('/admin/users', authenticate, authorize('admin'), (req, res) => {
  // Only admins can access
});
```

### 4. Data Protection

#### Sensitive Data Handling

```typescript
// Bad: Logging sensitive data
console.log('User login:', { email, password });

// Good: Exclude sensitive data
console.log('User login:', { email });

// Bad: Returning sensitive data
app.get('/api/users/:id', (req, res) => {
  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(req.params.id);
  res.json(user); // Includes password
});

// Good: Exclude sensitive fields
app.get('/api/users/:id', (req, res) => {
  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(req.params.id);
  const { password, ...safeUser } = user;
  res.json(safeUser);
});
```

#### Environment Variables

```typescript
// Bad: Hardcoded secrets
const apiKey = 'sk-1234567890abcdef';

// Good: Use environment variables
const apiKey = process.env.API_KEY;

// Validate required environment variables
const requiredEnvVars = ['API_KEY', 'DATABASE_URL', 'JWT_SECRET'];
const missing = requiredEnvVars.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}`
  );
}
```

#### File Upload Security

```typescript
import multer from 'multer';
import path from 'path';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.jpg', '.jpeg', '.png', '.gif', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  res.json({ filename: req.file.filename });
});
```

### 5. HTTP Security Headers

```typescript
import helmet from 'helmet';

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    frameguard: { action: 'deny' },
    xssFilter: true,
  })
);

// Additional headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );
  next();
});
```

### 6. Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply to all requests
app.use(limiter);

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 attempts per 15 minutes
  message: 'Too many login attempts, please try again later',
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  // Login logic
});
```

### 7. Error Handling

```typescript
// Bad: Exposing stack traces
app.use((err: Error, req: any, res: any, next: any) => {
  res.status(500).json({
    error: err.message,
    stack: err.stack, // Don't expose in production
  });
});

// Good: Generic error messages
app.use((err: Error, req: any, res: any, next: any) => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  res.status(500).json({
    error: isDevelopment ? err.message : 'Internal server error',
    ...(isDevelopment && { stack: err.stack }),
  });
});
```

### 8. Security Testing

```typescript
// tests/security/auth.test.ts
import request from 'supertest';
import app from '../../src/server/app';

describe('Security Tests', () => {
  describe('Authentication', () => {
    it('should reject requests without token', async () => {
      const response = await request(app).get('/api/protected').expect(401);

      expect(response.body.error).toContain('No token provided');
    });

    it('should reject invalid tokens', async () => {
      const response = await request(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.error).toContain('Invalid token');
    });
  });

  describe('Input Validation', () => {
    it('should reject SQL injection attempts', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({
          username: "admin'; DROP TABLE users; --",
          email: 'test@example.com',
          password: 'password123',
        })
        .expect(400);

      expect(response.body).toHaveProperty('errors');
    });

    it('should reject XSS attempts', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({
          username: '<script>alert("XSS")</script>',
          email: 'test@example.com',
          password: 'password123',
        })
        .expect(400);

      expect(response.body).toHaveProperty('errors');
    });
  });

  describe('Rate Limiting', () => {
    it('should limit login attempts', async () => {
      const credentials = {
        email: 'test@example.com',
        password: 'wrongpassword',
      };

      // Make 5 attempts (limit)
      for (let i = 0; i < 5; i++) {
        await request(app).post('/api/auth/login').send(credentials);
      }

      // 6th attempt should be rate limited
      const response = await request(app)
        .post('/api/auth/login')
        .send(credentials)
        .expect(429);

      expect(response.body.error).toContain('Too many requests');
    });
  });
});
```

## Tools to Use

- **Read**: Read security-related code
- **SearchCodebase**: Find security issues
- **Grep**: Search for vulnerabilities
- **RunCommand**: Run security scans
- **Write**: Fix security issues

## Best Practices

- Always validate and sanitize input
- Use parameterized queries
- Implement proper authentication
- Use HTTPS in production
- Keep dependencies updated
- Implement rate limiting
- Log security events
- Regular security audits
- Follow OWASP guidelines
- Educate team on security
