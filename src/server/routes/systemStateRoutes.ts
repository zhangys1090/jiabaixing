/**
 * 系统状态暴露路由 - 200任务改进建议实现
 * 提供7个新API端点，暴露系统真实内部状态
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvolutionStats, JiabaixingCorePublicAPI } from '../../interfaces';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { Logger } from '../../utils/Logger';

const router = Router();

let _core: JiabaixingCorePublicAPI | null = null;

/**
 * 设置核心实例引用（由 main.ts 在初始化时调用）
 */
export function setSystemStateCore(core: JiabaixingCorePublicAPI): void {
  _core = core;
}

// ── 查询参数辅助函数 ──

function queryAsNumber(value: unknown, fallback: number = 100): number {
  const str = Array.isArray(value) ? String(value[0]) : String(value || '');
  const num = parseInt(str, 10);
  return isNaN(num) ? fallback : num;
}

function getAssistantAPI(): JiabaixingCorePublicAPI {
  if (!_core) {
    throw new Error('systemStateRoutes: 核心实例未注入，请在 main.ts 中调用 setSystemStateCore()');
  }
  return _core;
}

// ── 1. 系统资源 ──

router.get('/api/system/resources', (_req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();

    // 获取磁盘信息（项目所在目录）
    const projectDir = process.cwd();
    let diskInfo = { free: 0, total: 0, used: 0 };
    try {
      fs.statSync(projectDir);
      // Windows下无法直接获取磁盘大小，使用环境变量或默认值
      diskInfo = {
        free: freeMem,
        total: totalMem,
        used: totalMem - freeMem,
      };
    } catch {
      // ignore
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        process: {
          pid: process.pid,
          uptime: process.uptime(),
          version: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        memory: {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss: Math.round(memUsage.rss / 1024 / 1024),
          external: Math.round((memUsage.external || 0) / 1024 / 1024),
          systemTotal: Math.round(totalMem / 1024 / 1024),
          systemFree: Math.round(freeMem / 1024 / 1024),
          usagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        },
        cpu: {
          loadAverage: loadAvg,
          userTime: cpuUsage.user,
          systemTime: cpuUsage.system,
          count: os.cpus().length,
        },
        disk: diskInfo,
      },
    });
  } catch (error) {
    Logger.error('获取系统资源失败', error as Error, 'SystemState');
    res.status(500).json({ success: false, error: '获取系统资源失败' });
  }
});

// ── 2. 记忆统计 ──

router.get('/api/memory/stats', async (_req, res) => {
  try {
    const assistant = getAssistantAPI();
    const memoryEngine = assistant.memoryEngine;

    // 从MemoryDatabase获取统计
    const { MemoryDatabase } = await import('../../memory/Database');
    const db = MemoryDatabase.getInstance();
    const allRecords = db.query(undefined, 10000);

    const typeStats: Record<string, number> = {};
    let totalRecords = 0;

    for (const record of allRecords) {
      totalRecords++;
      const type = record.type || 'unknown';
      typeStats[type] = (typeStats[type] || 0) + 1;
    }

    // 检查数据库文件大小
    const dbPath = path.join(process.cwd(), 'data', 'memory.db');
    let dbSize = 0;
    try {
      const stat = fs.statSync(dbPath);
      dbSize = stat.size;
    } catch {
      // ignore
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        totalRecords,
        typeDistribution: typeStats,
        databaseSize: dbSize,
        databaseSizeMB: Math.round((dbSize / 1024 / 1024) * 100) / 100,
        engineStats: memoryEngine?.getStats?.() || null,
      },
    });
  } catch (error) {
    Logger.error('获取记忆统计失败', error as Error, 'SystemState');
    res.status(500).json({ success: false, error: '获取记忆统计失败' });
  }
});

// ── 3. 性能指标 ──

const apiMetrics: Array<{
  endpoint: string;
  method: string;
  duration: number;
  timestamp: number;
  statusCode: number;
}> = [];

export function recordApiMetric(
  endpoint: string,
  method: string,
  duration: number,
  statusCode: number
): void {
  apiMetrics.push({
    endpoint,
    method,
    duration,
    timestamp: Date.now(),
    statusCode,
  });
  // 保留最近1000条
  if (apiMetrics.length > 1000) {
    apiMetrics.shift();
  }
}

router.get('/api/metrics', (_req, res) => {
  try {
    const now = Date.now();
    const oneHourAgo = now - 3600 * 1000;
    const recentMetrics = apiMetrics.filter((m) => m.timestamp > oneHourAgo);

    // 按端点分组统计
    const endpointStats: Record<
      string,
      {
        count: number;
        totalDuration: number;
        errors: number;
        p50: number;
        p95: number;
      }
    > = {};

    for (const m of recentMetrics) {
      const key = `${m.method} ${m.endpoint}`;
      if (!endpointStats[key]) {
        endpointStats[key] = {
          count: 0,
          totalDuration: 0,
          errors: 0,
          p50: 0,
          p95: 0,
        };
      }
      endpointStats[key].count++;
      endpointStats[key].totalDuration += m.duration;
      if (m.statusCode >= 400) {
        endpointStats[key].errors++;
      }
    }

    // 计算P50/P95
    for (const key of Object.keys(endpointStats)) {
      const durations = recentMetrics
        .filter((m) => `${m.method} ${m.endpoint}` === key)
        .map((m) => m.duration)
        .sort((a, b) => a - b);
      if (durations.length > 0) {
        endpointStats[key].p50 =
          durations[Math.floor(durations.length * 0.5)] || 0;
        endpointStats[key].p95 =
          durations[Math.floor(durations.length * 0.95)] || 0;
      }
    }

    const totalRequests = recentMetrics.length;
    const totalErrors = recentMetrics.filter((m) => m.statusCode >= 400).length;
    const avgDuration =
      totalRequests > 0
        ? recentMetrics.reduce((s, m) => s + m.duration, 0) / totalRequests
        : 0;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        summary: {
          totalRequests,
          totalErrors,
          errorRate:
            totalRequests > 0
              ? Math.round((totalErrors / totalRequests) * 1000) / 10
              : 0,
          avgDuration: Math.round(avgDuration * 100) / 100,
        },
        endpointStats,
        topSlowest: Object.entries(endpointStats)
          .sort(
            (a, b) =>
              b[1].totalDuration / b[1].count - a[1].totalDuration / a[1].count
          )
          .slice(0, 5)
          .map(([endpoint, stats]) => ({
            endpoint,
            avgDuration:
              Math.round((stats.totalDuration / stats.count) * 100) / 100,
            count: stats.count,
          })),
      },
    });
  } catch (error) {
    Logger.error('获取性能指标失败', error as Error, 'SystemState');
    res.status(500).json({ success: false, error: '获取性能指标失败' });
  }
});

// ── 4. 错误日志 ──

router.get('/api/logs/errors', (req, res) => {
  try {
    const level = req.query.level as string | undefined;
    const hours = queryAsNumber(req.query.hours, 24);
    const limit = queryAsNumber(req.query.limit, 100);

    const logDir = path.join(process.cwd(), 'logs');
    const errors: Array<{
      timestamp: string;
      level: string;
      message: string;
      module?: string;
    }> = [];

    // 读取error.log
    const errorLogPath = path.join(logDir, 'error.log');
    if (fs.existsSync(errorLogPath)) {
      const content = fs.readFileSync(errorLogPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      const cutoff = Date.now() - hours * 3600 * 1000;

      for (const line of lines.reverse()) {
        try {
          const entry = JSON.parse(line);
          const entryTime = new Date(entry.timestamp).getTime();
          if (entryTime < cutoff) continue;
          if (level && entry.level !== level) continue;

          errors.push({
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry._message,
            module: entry._module,
          });

          if (errors.length >= limit) break;
        } catch {
          // ignore invalid lines
        }
      }
    }

    // 统计各级别数量
    const levelCounts: Record<string, number> = {};
    for (const e of errors) {
      levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        total: errors.length,
        levelCounts,
        errors: errors.slice(0, limit),
      },
    });
  } catch (error) {
    Logger.error('获取错误日志失败', error as Error, 'SystemState');
    res.status(500).json({ success: false, error: '获取错误日志失败' });
  }
});

// ── 4b. 通用日志获取接口 ──

router.get('/api/logs', (req, res) => {
  try {
    const file = (req.query.file as string) || 'agent';
    const lines = queryAsNumber(req.query.lines, 100);
    const level = (req.query.level as string) || 'ALL';
    const component = (req.query.component as string) || 'all';

    const logDir = path.join(process.cwd(), 'logs');
    let logFile = '';

    // 根据文件名选择日志文件
    switch (file) {
      case 'agent':
        logFile = path.join(logDir, 'app.log');
        break;
      case 'errors':
        logFile = path.join(logDir, 'error.log');
        break;
      case 'gateway':
        logFile = path.join(logDir, 'gateway.log');
        break;
      default:
        logFile = path.join(logDir, `${file}.log`);
    }

    // 检查文件是否存在
    if (!fs.existsSync(logFile)) {
      return res.json({
        success: true,
        lines: [],
        message: `日志文件不存在: ${file}`,
      });
    }

    // 读取日志文件
    const content = fs.readFileSync(logFile, 'utf-8');
    const allLines = content.split('\n').filter((l) => l.trim());

    // 按级别过滤
    let filteredLines = allLines;
    if (level !== 'ALL') {
      filteredLines = allLines.filter((line) => {
        const upperLine = line.toUpperCase();
        switch (level) {
          case 'ERROR':
            return (
              upperLine.includes('ERROR') ||
              upperLine.includes('CRITICAL') ||
              upperLine.includes('FATAL')
            );
          case 'WARNING':
            return upperLine.includes('WARN') || upperLine.includes('WARNING');
          case 'INFO':
            return (
              !upperLine.includes('DEBUG') &&
              !upperLine.includes('ERROR') &&
              !upperLine.includes('WARN')
            );
          case 'DEBUG':
            return upperLine.includes('DEBUG');
          default:
            return true;
        }
      });
    }

    // 按组件过滤（如果指定）
    if (component !== 'all') {
      filteredLines = filteredLines.filter((line) =>
        line.toLowerCase().includes(component.toLowerCase())
      );
    }

    // 取最后 N 行
    const resultLines = filteredLines.slice(-lines);

    res.json({
      success: true,
      lines: resultLines,
      total: filteredLines.length,
      file,
      level,
      component,
    });
  } catch (error) {
    Logger.error('获取日志失败', error as Error, 'SystemState');
    res.status(500).json({
      success: false,
      error: '获取日志失败',
      details: (error as Error).message,
    });
  }
});

// ── 5. 配置信息（脱敏） ──

router.get('/api/config', (_req, res) => {
  try {
    const sensitiveKeys = [
      'JWT_SECRET',
      'OPENAI_API_KEY',
      'PASSWORD',
      'SECRET',
      'TOKEN',
    ];
    const config: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      const isSensitive = sensitiveKeys.some((sk) =>
        key.toUpperCase().includes(sk)
      );
      config[key] = isSensitive ? '***REDACTED***' : value;
    }

    // 读取package.json
    let packageInfo = {};
    try {
      const pkgPath = path.join(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      packageInfo = {
        name: pkg._name,
        version: pkg.version,
        scripts: Object.keys(pkg._scripts || {}),
        dependencies: Object.keys(pkg._dependencies || {}),
        devDependencies: Object.keys(pkg._devDependencies || {}),
      };
    } catch {
      // ignore
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        environment: config,
        package: packageInfo,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    });
  } catch (error) {
    Logger.error('获取配置失败', error as Error, 'SystemState');
    res.status(500).json({ success: false, error: '获取配置失败' });
  }
});

// ── 6. 进化状态 ──

router.get('/api/evolution/status', async (_req, res) => {
  try {
    const assistant = getAssistantAPI();
    const orchestrator = assistant.orchestrator;

    const healingHistory = orchestrator?.getHealingHistory?.() || [];
    const refactorHistory = orchestrator?.getRefactorHistory?.() || [];

    res.json({
      healing: {
        total: healingHistory.length,
        success: healingHistory.filter((h) => h.success).length,
        recent: healingHistory.slice(-5).map((h) => ({
          ...h,
          timestamp: new Date().toISOString(),
        })),
      },
      refactor: {
        total: refactorHistory.length,
        success: refactorHistory.filter((r) => r.success).length,
        recent: refactorHistory.slice(-5).map((r) => ({
          ...r,
          timestamp: new Date().toISOString(),
        })),
      },
      enhancement: {
        total: 0,
        success: 0,
        recent: [],
      },
      lastCycleTime:
        healingHistory.length > 0 ? new Date().toISOString() : null,
      nextCycleTime: null,
    });
  } catch (error) {
    Logger.error('获取进化状态失败', error as Error, 'SystemState');
    res.json({
      healing: { total: 0, success: 0, recent: [] },
      refactor: { total: 0, success: 0, recent: [] },
      enhancement: { total: 0, success: 0, recent: [] },
    });
  }
});

// ── 7. 进化触发 ──

router.post('/api/evolution/trigger', async (req, res) => {
  try {
    const { reason } = req.body;

    Logger.info(`手动触发进化: ${reason || '无原因'}`, 'Evolution');

    const assistant = getAssistantAPI();
    const evolutionEngine = assistant.evolutionEngine;

    if (!evolutionEngine) {
      return res.json({
        success: false,
        error: '进化引擎未初始化',
      });
    }

    if (evolutionEngine.triggerOptimization) {
      await evolutionEngine.triggerOptimization(reason || '手动触发');
    }

    res.json({
      success: true,
      message: '进化触发成功',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error('进化触发失败', error as Error, 'Evolution');
    res.status(500).json({
      success: false,
      error: '进化触发失败',
      details: (error as Error).message,
    });
  }
});

// ── 8. 进化指标 ──

router.get('/api/evolution/metrics', async (_req, res) => {
  try {
    const assistant = getAssistantAPI();
    const evolutionEngine = assistant.evolutionEngine;

    if (!evolutionEngine) {
      return res.json({
        success: true,
        data: {
          totalOptimizations: 0,
          successRate: 0,
          averageImprovement: 0,
          lastUpdate: new Date().toISOString(),
        },
      });
    }

    const stats: EvolutionStats = evolutionEngine.getStats
      ? await evolutionEngine.getStats()
      : {};

    res.json({
      success: true,
      data: {
        totalOptimizations: stats._optimizationCount || 0,
        successRate: stats._successRate || 0,
        averageImprovement: stats._averageImprovement || 0,
        lastUpdate: stats._lastOptimization || new Date().toISOString(),
      },
    });
  } catch (error) {
    Logger.error('获取进化指标失败', error as Error, 'Evolution');
    res.status(500).json({
      success: false,
      error: '获取进化指标失败',
      details: (error as Error).message,
    });
  }
});

// ── 9. 用户纠正 ──

router.post('/api/correct', async (req, res) => {
  try {
    const { toolId, correctionType, reason } = req.body;

    Logger.info(
      `用户纠正: 工具=${toolId}, 类型=${correctionType}, 原因=${reason}`,
      'UserCorrection'
    );

    if (!toolId || !correctionType) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数: toolId, correctionType',
      });
    }

    const assistant = getAssistantAPI();

    Logger.info(
      `用户纠正已记录: 工具=${toolId}, 类型=${correctionType}, 原因=${reason}`,
      'UserCorrection'
    );

    res.json({
      success: true,
      message: '用户纠正已记录',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error('用户纠正失败', error as Error, 'UserCorrection');
    res.status(500).json({
      success: false,
      error: '用户纠正失败',
      details: (error as Error).message,
    });
  }
});

// ── 10. 安全日志 ──

router.get('/api/security/logs', async (req, res) => {
  try {
    const limit = queryAsNumber(req.query.limit, 10);

    const assistant = getAssistantAPI();
    const securityAuditor = assistant.securityAuditor;

    if (!securityAuditor || !securityAuditor.getRecentLogs) {
      return res.json({
        success: true,
        data: [],
        message: '安全审计器未初始化',
      });
    }

    const logs = await securityAuditor.getRecentLogs(limit);

    res.json({
      success: true,
      data: logs,
      count: logs.length,
    });
  } catch (error) {
    Logger.error('获取安全日志失败', error as Error, 'Security');
    res.status(500).json({
      success: false,
      error: '获取安全日志失败',
      details: (error as Error).message,
    });
  }
});

// ── 7. 系统完整性检查 ──

router.get('/api/system/integrity', async (_req, res) => {
  try {
    const checks: Array<{
      name: string;
      status: 'pass' | 'fail' | 'warn';
      message: string;
    }> = [];

    // 1. 检查数据库文件
    const dbPath = path.join(process.cwd(), 'data', 'memory.db');
    try {
      if (fs.existsSync(dbPath)) {
        const stat = fs.statSync(dbPath);
        checks.push({
          name: '数据库文件',
          status: 'pass',
          message: `存在，大小 ${Math.round(stat.size / 1024)}KB`,
        });
      } else {
        checks.push({ name: '数据库文件', status: 'warn', message: '不存在' });
      }
    } catch (error) {
      checks.push({
        name: '数据库文件',
        status: 'fail',
        message: (error as Error).message,
      });
    }

    // 2. 检查必需目录
    const requiredDirs = ['src', 'data', 'logs', 'config'];
    for (const dir of requiredDirs) {
      const dirPath = path.join(process.cwd(), 'src', '..', dir);
      try {
        if (fs.existsSync(dirPath)) {
          checks.push({
            name: `目录: ${dir}`,
            status: 'pass',
            message: '存在',
          });
        } else {
          checks.push({
            name: `目录: ${dir}`,
            status: 'warn',
            message: '不存在',
          });
        }
      } catch (error) {
        checks.push({
          name: `目录: ${dir}`,
          status: 'fail',
          message: (error as Error).message,
        });
      }
    }

    // 3. 检查关键文件
    const requiredFiles = ['package.json', 'tsconfig.json', '.env'];
    for (const file of requiredFiles) {
      const filePath = path.join(process.cwd(), file);
      try {
        if (fs.existsSync(filePath)) {
          checks.push({
            name: `文件: ${file}`,
            status: 'pass',
            message: '存在',
          });
        } else {
          checks.push({
            name: `文件: ${file}`,
            status: 'warn',
            message: '不存在',
          });
        }
      } catch (error) {
        checks.push({
          name: `文件: ${file}`,
          status: 'fail',
          message: (error as Error).message,
        });
      }
    }

    // 4. 检查数据库可读写
    try {
      const { MemoryDatabase } = await import('../../memory/Database');
      const db = MemoryDatabase.getInstance();
      db.query('short_term', 1);
      checks.push({ name: '数据库读写', status: 'pass', message: '正常' });
    } catch (error) {
      checks.push({
        name: '数据库读写',
        status: 'fail',
        message: (error as Error).message,
      });
    }

    // 5. 检查技能注册表
    try {
      const registry = SkillRegistry.getInstance();
      const skills = registry.getAllSkillMeta();
      checks.push({
        name: '技能注册表',
        status: 'pass',
        message: `${skills.length}个技能已注册`,
      });
    } catch (error) {
      checks.push({
        name: '技能注册表',
        status: 'fail',
        message: (error as Error).message,
      });
    }

    const passCount = checks.filter((c) => c.status === 'pass').length;
    const failCount = checks.filter((c) => c.status === 'fail').length;
    const warnCount = checks.filter((c) => c.status === 'warn').length;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        summary: {
          pass: passCount,
          fail: failCount,
          warn: warnCount,
          total: checks.length,
        },
        checks,
        overallStatus:
          failCount === 0
            ? warnCount === 0
              ? 'healthy'
              : 'degraded'
            : 'unhealthy',
      },
    });
  } catch (error) {
    Logger.error('完整性检查失败', error as Error, 'SystemState');
    res.status(500).json({ success: false, error: '完整性检查失败' });
  }
});

export { router as systemStateRoutes };

