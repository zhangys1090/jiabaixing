---
name: 'debugging-tools'
description: 'Use advanced debugging tools and techniques to identify and fix complex issues. Invoke when debugging complex problems, investigating bugs, or troubleshooting system issues.'
---

# Debugging Tools

This skill provides advanced debugging tools and techniques.

## When to Use

- Debugging complex issues
- Investigating hard-to-reproduce bugs
- Troubleshooting system problems
- Analyzing performance bottlenecks
- Tracing execution flow
- Inspecting application state

## Debugging Techniques

### 1. Logging and Tracing

```typescript
import { Logger } from './utils/Logger';

// Structured logging
Logger.info(
  'Processing request',
  {
    requestId: 'req-123',
    userId: 'user-456',
    action: 'create_item',
  },
  'RequestHandler'
);

// Error logging with context
Logger.error('Failed to process request', error, 'RequestHandler', {
  requestId: 'req-123',
  userId: 'user-456',
  errorDetails: {
    message: error.message,
    stack: error.stack,
  },
});

// Performance logging
const start = Date.now();
// ... code ...
const duration = Date.now() - start;
Logger.debug(`Operation completed in ${duration}ms`, 'Performance');
```

### 2. Debugging Middleware

```typescript
import { Request, Response, NextFunction } from 'express';

export function debugMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const startTime = Date.now();

  // Log request details
  console.log('🔍 [DEBUG] Request:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
    query: req.query,
  });

  // Intercept response
  const originalSend = res.send;
  res.send = function (data) {
    const duration = Date.now() - startTime;

    console.log('🔍 [DEBUG] Response:', {
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      data: data,
    });

    return originalSend.call(this, data);
  };

  next();
}

// Use in app
app.use(debugMiddleware);
```

### 3. State Inspection

```typescript
class StateInspector {
  private snapshots: Map<string, any> = new Map();

  captureSnapshot(label: string, state: any): void {
    this.snapshots.set(label, JSON.parse(JSON.stringify(state)));
  }

  compareSnapshots(label1: string, label2: string): any {
    const snapshot1 = this.snapshots.get(label1);
    const snapshot2 = this.snapshots.get(label2);

    return this.deepDiff(snapshot1, snapshot2);
  }

  private deepDiff(obj1: any, obj2: any): any {
    const diff: any = {};

    for (const key in obj2) {
      if (obj1[key] !== obj2[key]) {
        if (typeof obj2[key] === 'object' && obj2[key] !== null) {
          diff[key] = this.deepDiff(obj1[key] || {}, obj2[key]);
        } else {
          diff[key] = {
            old: obj1[key],
            new: obj2[key],
          };
        }
      }
    }

    return diff;
  }

  printSnapshot(label: string): void {
    const snapshot = this.snapshots.get(label);
    console.log(`📸 [SNAPSHOT] ${label}:`, JSON.stringify(snapshot, null, 2));
  }
}
```

### 4. Memory Profiling

```typescript
class MemoryProfiler {
  private snapshots: Map<string, NodeJS.MemoryUsage> = new Map();

  takeSnapshot(label: string): void {
    const usage = process.memoryUsage();
    this.snapshots.set(label, usage);

    console.log(`💾 [MEMORY] ${label}:`, {
      heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`,
    });
  }

  compareSnapshots(label1: string, label2: string): void {
    const snap1 = this.snapshots.get(label1);
    const snap2 = this.snapshots.get(label2);

    if (snap1 && snap2) {
      const diff = {
        heapUsed: snap2.heapUsed - snap1.heapUsed,
        heapTotal: snap2.heapTotal - snap1.heapTotal,
        external: snap2.external - snap1.external,
      };

      console.log(`📊 [MEMORY DIFF] ${label1} -> ${label2}:`, {
        heapUsed: `${Math.round(diff.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(diff.heapTotal / 1024 / 1024)}MB`,
        external: `${Math.round(diff.external / 1024 / 1024)}MB`,
      });
    }
  }

  detectLeaks(): void {
    const usage = process.memoryUsage();
    const heapUsedMB = usage.heapUsed / 1024 / 1024;

    if (heapUsedMB > 500) {
      console.warn('⚠️ [MEMORY LEAK] High memory usage detected:', heapUsedMB);
    }
  }
}
```

### 5. Performance Tracing

```typescript
class PerformanceTracer {
  private traces: Map<string, number[]> = new Map();

  startTrace(operation: string): string {
    const traceId = `${operation}-${Date.now()}`;
    this.traces.set(traceId, [Date.now()]);
    return traceId;
  }

  endTrace(traceId: string): number {
    const times = this.traces.get(traceId);
    if (times) {
      const duration = Date.now() - times[0];
      times.push(duration);
      return duration;
    }
    return 0;
  }

  getStats(operation: string): {
    count: number;
    avg: number;
    min: number;
    max: number;
  } {
    const durations = Array.from(this.traces.values())
      .filter((times) => times.length === 2)
      .map((times) => times[1]);

    if (durations.length === 0) {
      return { count: 0, avg: 0, min: 0, max: 0 };
    }

    return {
      count: durations.length,
      avg: durations.reduce((a, b) => a + b, 0) / durations.length,
      min: Math.min(...durations),
      max: Math.max(...durations),
    };
  }

  printStats(operation: string): void {
    const stats = this.getStats(operation);
    console.log(`⏱️ [PERF] ${operation}:`, stats);
  }
}
```

### 6. Error Tracking

```typescript
class ErrorTracker {
  private errors: Map<string, ErrorInfo[]> = new Map();

  trackError(error: Error, context?: any): void {
    const errorType = error.constructor.name;

    if (!this.errors.has(errorType)) {
      this.errors.set(errorType, []);
    }

    this.errors.get(errorType)!.push({
      message: error.message,
      stack: error.stack,
      context,
      timestamp: new Date(),
    });

    console.error('❌ [ERROR] Tracked:', {
      type: errorType,
      message: error.message,
      context,
    });
  }

  getErrorStats(): Record<string, number> {
    const stats: Record<string, number> = {};

    for (const [errorType, errors] of this.errors.entries()) {
      stats[errorType] = errors.length;
    }

    return stats;
  }

  getRecentErrors(type?: string, limit: number = 10): ErrorInfo[] {
    let errors: ErrorInfo[] = [];

    if (type) {
      errors = this.errors.get(type) || [];
    } else {
      for (const errorList of this.errors.values()) {
        errors = errors.concat(errorList);
      }
    }

    return errors
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
}

interface ErrorInfo {
  message: string;
  stack?: string;
  context?: any;
  timestamp: Date;
}
```

### 7. Request/Response Logging

```typescript
class RequestLogger {
  logRequest(req: Request): void {
    console.log('📥 [REQUEST]', {
      method: req.method,
      url: req.url,
      headers: this.sanitizeHeaders(req.headers),
      body: this.sanitizeBody(req.body),
      query: req.query,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });
  }

  logResponse(req: Request, res: Response, duration: number): void {
    console.log('📤 [RESPONSE]', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });
  }

  private sanitizeHeaders(headers: any): any {
    const sanitized = { ...headers };
    delete sanitized.authorization;
    delete sanitized.cookie;
    return sanitized;
  }

  private sanitizeBody(body: any): any {
    if (!body) return body;

    const sanitized = { ...body };
    delete sanitized.password;
    delete sanitized.token;
    return sanitized;
  }
}
```

## Debugging Workflow

```typescript
// 1. Setup debugging tools
const logger = new Logger();
const stateInspector = new StateInspector();
const memoryProfiler = new MemoryProfiler();
const performanceTracer = new PerformanceTracer();
const errorTracker = new ErrorTracker();

// 2. Use in code
async function processRequest(req: Request, res: Response) {
  const traceId = performanceTracer.startTrace('processRequest');

  try {
    // Capture initial state
    stateInspector.captureSnapshot('initial', { req });

    // Take memory snapshot
    memoryProfiler.takeSnapshot('before-processing');

    // Process request
    const result = await doWork(req);

    // Capture final state
    stateInspector.captureSnapshot('final', { result });

    // Compare states
    const diff = stateInspector.compareSnapshots('initial', 'final');
    console.log('State changes:', diff);

    // End trace
    const duration = performanceTracer.endTrace(traceId);
    performanceTracer.printStats('processRequest');

    res.json(result);
  } catch (error) {
    // Track error
    errorTracker.trackError(error as Error, { req });

    // Check for memory leaks
    memoryProfiler.detectLeaks();

    res.status(500).json({ error: 'Internal server error' });
  } finally {
    // Take final memory snapshot
    memoryProfiler.takeSnapshot('after-processing');
    memoryProfiler.compareSnapshots('before-processing', 'after-processing');
  }
}
```

## Tools to Use

- **Read**: Read debugging code
- **SearchCodebase**: Find debugging implementations
- **Grep**: Search for debug statements
- **RunCommand**: Run with debug flags
- **Write**: Create debugging scripts

## Best Practices

- Use structured logging
- Capture context with errors
- Monitor performance metrics
- Track state changes
- Profile memory usage
- Trace execution flow
- Log request/response pairs
- Use meaningful labels
