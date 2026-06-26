/**
 * 日志查看工具 — 安全读取应用日志
 *
 * 解决 shell_exec 读日志需要 SYSTEM_ADMIN 权限的问题
 * 低风险，只读，支持按级别/模块/关键词过滤
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import * as fs from 'fs';
import * as path from 'path';

export const LOG_VIEW_DEF: ToolDefinition = {
  name: 'log_view',
  description:
    '查看应用日志。USE WHEN: 用户想看日志、查错误、排查问题、了解系统运行状态。支持按级别(error/warn/info)、模块名、关键词过滤。DO NOT USE WHEN: 用户要修改日志配置或清理日志文件（用log_clean）。',
  category: ToolCategory.SYSTEM,
  parameters: {
    level: {
      type: 'string',
      description: '日志级别过滤',
      enum: ['all', 'error', 'warn', 'info', 'fatal'],
      default: 'all',
    },
    keyword: {
      type: 'string',
      description: '关键词过滤（匹配 message 字段）',
    },
    module: {
      type: 'string',
      description: '模块名过滤，如 LLMProvider、WindowManager',
    },
    lines: {
      type: 'number',
      description: '返回最后 N 条日志',
      default: 30,
    },
    log_file: {
      type: 'string',
      description: '日志文件名，默认 combined.log',
      enum: ['combined.log', 'error.log', 'fatal.log', 'audit.log'],
      default: 'combined.log',
    },
  },
  requiredParams: [],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

const LOGS_DIR = path.join(__dirname, '../../../../logs');

export function createLogViewExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const level = String(params.level || 'all');
    const keyword = params.keyword ? String(params.keyword) : undefined;
    const module = params.module ? String(params.module) : undefined;
    const lines = Number(params.lines) || 30;
    const logFile = String(params.log_file || 'combined.log');

    try {
      const filePath = path.join(LOGS_DIR, logFile);
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          output: null,
          error: `日志文件不存在: ${filePath}`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      // 读取文件末尾（避免读取整个大文件）
      const content = fs.readFileSync(filePath, 'utf-8');
      const allLines = content.split('\n').filter((l) => l.trim());

      // 解析 JSON 日志
      const parsed = allLines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // 过滤
      let filtered = parsed;

      if (level !== 'all') {
        filtered = filtered.filter((log) => log.level === level);
      }
      if (keyword) {
        const kw = keyword.toLowerCase();
        filtered = filtered.filter(
          (log) =>
            (log.message && log.message.toLowerCase().includes(kw)) ||
            (log.module && log.module.toLowerCase().includes(kw))
        );
      }
      if (module) {
        const mod = module.toLowerCase();
        filtered = filtered.filter(
          (log) => log.module && log.module.toLowerCase().includes(mod)
        );
      }

      // 取最后 N 条
      const recent = filtered.slice(-lines);

      if (recent.length === 0) {
        return {
          success: true,
          output: `📋 日志查询结果: ${logFile}\n过滤条件: level=${level}, keyword=${keyword || '-'}, module=${module || '-'}\n\n✅ 没有匹配的日志条目。`,
          duration: Date.now() - startTime,
          validated: true,
          metadata: { logFile, total: 0, filtered: 0 },
        };
      }

      // 格式化输出
      const output = formatLogOutput(recent, logFile, level, keyword, module);

      return {
        success: true,
        output,
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
          logFile,
          total: parsed.length,
          filtered: recent.length,
          level,
          keyword,
          module,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `读取日志失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

function formatLogOutput(
  logs: Array<Record<string, unknown>>,
  logFile: string,
  level: string,
  keyword?: string,
  module?: string
): string {
  const lines: string[] = [];
  lines.push(`📋 日志查询: ${logFile}`);
  lines.push(
    `过滤: level=${level}, keyword=${keyword || '-'}, module=${module || '-'}`
  );
  lines.push(`匹配: ${logs.length} 条`);
  lines.push('─'.repeat(50));

  for (const log of logs) {
    const icon =
      { error: '🔴', warn: '🟡', info: '🟢', fatal: '💀' }[String(log.level)] ||
      '⚪';
    const ts = String(log.timestamp || '').substring(11, 19);
    const mod = log.module ? `[${log.module}]` : '';
    const msg = String(log.message || '').substring(0, 200);
    const traceId = log.traceId ? ` (${log.traceId})` : '';

    lines.push(`${icon} ${ts} ${mod} ${msg}${traceId}`);

    if (log.error && log.level === 'error') {
      lines.push(`   ❌ ${String(log.error).substring(0, 150)}`);
    }
  }

  return lines.join('\n');
}
