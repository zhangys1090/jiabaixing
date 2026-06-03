---
name: 'deployment'
description: 'Deploy applications, manage environments, and handle deployment issues. Invoke when user needs to deploy the application, configure environments, or fix deployment problems.'
---

# Deployment

This skill helps deploy applications and manage deployment issues.

## When to Use

- Deploying to production
- Setting up staging environments
- Configuring deployment pipelines
- Fixing deployment issues
- Managing environment variables
- Setting up CI/CD
- Rolling back deployments

## Deployment Process

### 1. Pre-Deployment Checklist

Before deploying:

```bash
# Run all tests
npm test

# Run linting
npm run lint

# Build the application
npm run build

# Check for security vulnerabilities
npm audit

# Verify environment variables
cat .env.production
```

### 2. Environment Configuration

Create environment-specific configs:

```bash
# .env.development
NODE_ENV=development
PORT=3111
DATABASE_URL=./database.sqlite
LOG_LEVEL=debug

# .env.staging
NODE_ENV=staging
PORT=3111
DATABASE_URL=./database-staging.sqlite
LOG_LEVEL=info

# .env.production
NODE_ENV=production
PORT=3111
DATABASE_URL=./database.sqlite
LOG_LEVEL=warn
```

### 3. Build for Production

```bash
# Build backend
npm run build

# Build frontend
cd src/frontend
npm run build

# Verify build output
ls -la dist/
ls -la src/frontend/build/
```

### 4. Deployment Methods

#### PM2 Deployment

```bash
# Install PM2 globally
npm install -g pm2

# Create ecosystem.config.js
module.exports = {
  apps: [{
    name: 'jiabaixing-backend',
    script: './dist/main.js',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'development',
      PORT: 3111
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3111
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '1G'
  }]
};

# Start application
pm2 start ecosystem.config.js --env production

# Check status
pm2 status

# View logs
pm2 logs jiabaixing-backend

# Restart application
pm2 restart jiabaixing-backend

# Stop application
pm2 stop jiabaixing-backend

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

#### Docker Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY src/frontend/package*.json ./src/frontend/

# Install dependencies
RUN npm ci --only=production
RUN cd src/frontend && npm ci --only=production

# Copy source code
COPY . .

# Build application
RUN npm run build
RUN cd src/frontend && npm run build

# Expose port
EXPOSE 3111

# Start application
CMD ["node", "dist/main.js"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  backend:
    build: .
    ports:
      - '3111:3111'
    environment:
      - NODE_ENV=production
      - PORT=3111
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
    restart: unless-stopped
    healthcheck:
      test:
        [
          'CMD',
          'wget',
          '--quiet',
          '--tries=1',
          '--spider',
          'http://localhost:3111/health',
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  nginx:
    image: nginx:alpine
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - backend
    restart: unless-stopped
```

```bash
# Build and run with Docker
docker-compose build
docker-compose up -d

# Check logs
docker-compose logs -f backend

# Stop services
docker-compose down

# Update deployment
docker-compose pull
docker-compose up -d
```

#### CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
      - run: npm run lint

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.HOST }}
          username: ${{ secrets.USERNAME }}
          key: ${{ secrets.SSH_KEY }}
          script: |
            cd /app/jiabaixing
            git pull origin main
            npm ci --only=production
            npm run build
            pm2 restart jiabaixing-backend
```

### 5. Health Checks

Implement health check endpoint:

```typescript
// src/server/health.ts
import express from 'express';
import Database from 'better-sqlite3';

const router = express.Router();

router.get('/health', (req, res) => {
  try {
    // Check database
    const db = new Database(process.env.DATABASE_URL || './database.sqlite');
    db.prepare('SELECT 1').get();
    db.close();

    // Check memory
    const memUsage = process.memoryUsage();
    const memPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      memory: {
        used: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        total: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        percent: `${Math.round(memPercent)}%`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
    });
  }
});

export default router;
```

### 6. Monitoring & Logging

```typescript
// src/server/monitoring.ts
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

// Monitor application
setInterval(() => {
  const memUsage = process.memoryUsage();
  logger.info('Memory usage', {
    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
  });
}, 60000); // Every minute
```

### 7. Rollback Strategy

```bash
# Create backup before deployment
backup_database() {
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  cp database.sqlite "backups/database_${TIMESTAMP}.sqlite"
  echo "Database backed up to database_${TIMESTAMP}.sqlite"
}

# Rollback function
rollback() {
  echo "Rolling back deployment..."
  pm2 stop jiabaixing-backend
  git revert HEAD
  npm ci --only=production
  npm run build
  pm2 start jiabaixing-backend
  echo "Rollback completed"
}

# Deploy with rollback option
deploy() {
  backup_database

  if ! npm ci --only=production; then
    echo "Dependency installation failed, rolling back..."
    rollback
    exit 1
  fi

  if ! npm run build; then
    echo "Build failed, rolling back..."
    rollback
    exit 1
  fi

  pm2 restart jiabaixing-backend

  # Health check
  sleep 10
  if ! curl -f http://localhost:3111/health; then
    echo "Health check failed, rolling back..."
    rollback
    exit 1
  fi

  echo "Deployment successful"
}
```

### 8. Post-Deployment Verification

```bash
# Verify deployment
verify_deployment() {
  echo "Verifying deployment..."

  # Check if service is running
  pm2 status jiabaixing-backend

  # Check health endpoint
  curl http://localhost:3111/health

  # Check logs for errors
  tail -n 100 logs/pm2-error.log | grep -i error

  # Run smoke tests
  npm run test:smoke

  echo "Verification completed"
}
```

## Tools to Use

- **Read**: Read deployment configs
- **SearchCodebase**: Find deployment scripts
- **Grep**: Search for environment variables
- **RunCommand**: Run deployment commands
- **Write**: Create deployment configs

## Best Practices

- Always test before deploying
- Use environment-specific configs
- Implement health checks
- Monitor logs and metrics
- Have rollback plan ready
- Use blue-green deployment
- Keep backups
- Document deployment process
- Automate where possible
- Secure sensitive data
