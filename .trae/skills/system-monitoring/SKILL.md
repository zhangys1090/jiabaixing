---
name: 'system-monitoring'
description: 'Monitor system health, track performance metrics, and analyze resource usage. Invoke when monitoring system performance, analyzing metrics, or investigating system issues.'
---

# System Monitoring

This skill helps monitor system health and performance.

## When to Use

- Monitoring system performance
- Tracking resource usage
- Analyzing metrics and logs
- Investigating system issues
- Setting up alerts
- Performance profiling
- Capacity planning

## Monitoring Setup

### 1. Performance Monitoring

```typescript
import { PerformanceMonitor } from './monitoring/PerformanceMonitor';

const monitor = new PerformanceMonitor();

// Start monitoring
monitor.start();

// Track custom metrics
monitor.trackMetric('api_response_time', 150);
monitor.trackMetric('memory_usage', process.memoryUsage().heapUsed);

// Get metrics
const metrics = monitor.getMetrics();
console.log('Average response time:', metrics.api_response_time.avg);
```

### 2. Resource Monitoring

```typescript
class ResourceMonitor {
  getCpuUsage(): number {
    const cpus = require('os').cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu: any) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    return ((totalTick - totalIdle) / totalTick) * 100;
  }

  getMemoryUsage(): {
    used: number;
    total: number;
    percentage: number;
  } {
    const usage = process.memoryUsage();
    const total = require('os').totalmem();
    const used = usage.heapUsed;

    return {
      used: Math.round(used / 1024 / 1024), // MB
      total: Math.round(total / 1024 / 1024), // MB
      percentage: (used / total) * 100,
    };
  }

  getDiskUsage(path: string): {
    used: number;
    total: number;
    percentage: number;
  } {
    const stats = require('fs').statSync(path);
    // Implementation depends on OS
    return {
      used: 0,
      total: 0,
      percentage: 0,
    };
  }
}
```

### 3. Log Monitoring

```typescript
class LogMonitor {
  private logFile: string;
  private watcher: any;

  constructor(logFile: string) {
    this.logFile = logFile;
  }

  startMonitoring(callback: (line: string) => void): void {
    const fs = require('fs');
    const readline = require('readline');

    const stream = fs.createReadStream(this.logFile, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line: string) => {
      if (line.includes('ERROR') || line.includes('WARN')) {
        callback(line);
      }
    });
  }

  searchLogs(pattern: string, limit: number = 100): string[] {
    const fs = require('fs');
    const content = fs.readFileSync(this.logFile, 'utf-8');
    const lines = content.split('\n');

    return lines.filter((line) => line.includes(pattern)).slice(-limit);
  }
}
```

### 4. API Monitoring

```typescript
class ApiMonitor {
  private requests: Map<string, number[]> = new Map();

  trackRequest(endpoint: string, duration: number): void {
    if (!this.requests.has(endpoint)) {
      this.requests.set(endpoint, []);
    }
    this.requests.get(endpoint)!.push(duration);
  }

  getMetrics(endpoint: string): {
    count: number;
    avg: number;
    min: number;
    max: number;
    p95: number;
    p99: number;
  } {
    const durations = this.requests.get(endpoint) || [];
    const sorted = [...durations].sort((a, b) => a - b);

    return {
      count: durations.length,
      avg: durations.reduce((a, b) => a + b, 0) / durations.length,
      min: sorted[0] || 0,
      max: sorted[sorted.length - 1] || 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
    };
  }

  getSlowEndpoints(threshold: number): string[] {
    const slowEndpoints: string[] = [];

    for (const [endpoint, durations] of this.requests.entries()) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      if (avg > threshold) {
        slowEndpoints.push(endpoint);
      }
    }

    return slowEndpoints;
  }
}
```

### 5. Health Checks

```typescript
class HealthChecker {
  async checkDatabase(): Promise<boolean> {
    try {
      const db = new Database('path/to/db.sqlite');
      db.prepare('SELECT 1').get();
      db.close();
      return true;
    } catch (error) {
      return false;
    }
  }

  async checkExternalService(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async checkDiskSpace(path: string, threshold: number): Promise<boolean> {
    const stats = require('fs').statSync(path);
    // Check if disk space is above threshold
    return true;
  }

  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Record<string, boolean>;
  }> {
    const checks = {
      database: await this.checkDatabase(),
      externalService: await this.checkExternalService(
        'https://api.example.com'
      ),
      diskSpace: await this.checkDiskSpace('./', 10), // 10% threshold
    };

    const allHealthy = Object.values(checks).every((check) => check);
    const someHealthy = Object.values(checks).some((check) => check);

    return {
      status: allHealthy ? 'healthy' : someHealthy ? 'degraded' : 'unhealthy',
      checks,
    };
  }
}
```

### 6. Alerting

```typescript
class AlertManager {
  private alerts: Map<string, AlertRule> = new Map();

  addRule(rule: AlertRule): void {
    this.alerts.set(rule.id, rule);
  }

  checkRules(metrics: Record<string, number>): Alert[] {
    const triggeredAlerts: Alert[] = [];

    for (const rule of this.alerts.values()) {
      const value = metrics[rule.metric];
      if (value !== undefined) {
        const triggered = rule.condition(value);
        if (triggered) {
          triggeredAlerts.push({
            id: rule.id,
            message: rule.message,
            severity: rule.severity,
            value,
            timestamp: new Date(),
          });
        }
      }
    }

    return triggeredAlerts;
  }

  sendAlert(alert: Alert): void {
    // Send alert via email, Slack, etc.
    console.log(`ALERT [${alert.severity}]: ${alert.message}`);
  }
}

interface AlertRule {
  id: string;
  metric: string;
  condition: (value: number) => boolean;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

interface Alert {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  value: number;
  timestamp: Date;
}
```

## Monitoring Dashboard

```typescript
// Create monitoring dashboard
const express = require('express');
const app = express();

app.get('/metrics', (req, res) => {
  const metrics = {
    cpu: resourceMonitor.getCpuUsage(),
    memory: resourceMonitor.getMemoryUsage(),
    api: apiMonitor.getMetrics('/api/data'),
    health: healthChecker.getHealthStatus(),
  };

  res.json(metrics);
});

app.get('/health', async (req, res) => {
  const health = await healthChecker.getHealthStatus();
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

app.listen(3001, () => {
  console.log('Monitoring dashboard running on port 3001');
});
```

## Tools to Use

- **Read**: Read monitoring code
- **SearchCodebase**: Find monitoring implementations
- **Grep**: Search for metrics
- **RunCommand**: Start monitoring, check logs
- **Write**: Create monitoring scripts

## Best Practices

- Monitor key metrics continuously
- Set up appropriate alerts
- Log important events
- Track performance over time
- Monitor resource usage
- Check system health regularly
- Analyze trends and patterns
- Plan for capacity growth
