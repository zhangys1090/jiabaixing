/**
 * CSV 分析工具 — 解析 CSV 文件并生成统计摘要
 *
 * 从 Agent Data Analysis 工作流学到：
 * - 解析 + 统计 + 洞察三步骤
 * - 返回 summary + structured data 双格式
 * - 渐进式披露：先给摘要，用户需要再深入
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import * as fs from 'fs';

export const CSV_ANALYZE_DEF: ToolDefinition = {
  name: 'csv_analyze',
  description:
    '分析CSV文件，生成统计摘要和关键洞察。USE WHEN: 用户要求分析数据、查看CSV内容、生成数据报告。DO NOT USE WHEN: 用户要读取普通文本文件（用file_read）。返回行数、列数、每列统计、数据质量提示。',
  category: ToolCategory.CODE,
  parameters: {
    file_path: {
      type: 'string',
      description: 'CSV文件路径',
    },
    max_rows: {
      type: 'number',
      description: '最大读取行数',
      default: 10000,
    },
    delimiter: {
      type: 'string',
      description: '分隔符，默认自动检测',
      default: ',',
    },
  },
  requiredParams: ['file_path'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

interface ColumnStats {
  name: string;
  type: 'number' | 'string' | 'date' | 'boolean';
  nonNullCount: number;
  nullCount: number;
  uniqueCount: number;
  min?: number;
  max?: number;
  mean?: number;
  topValues?: Array<{ value: string; count: number }>;
}

export function createCsvAnalyzeExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const filePath = String(params.file_path || '');
    const maxRows = Number(params.max_rows || 10000);
    const delimiter = String(params.delimiter || ',');

    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          output: null,
          error: `文件不存在: ${filePath}`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      if (lines.length < 2) {
        return {
          success: false,
          output: null,
          error: 'CSV文件至少需要表头+1行数据',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      // 解析表头
      const headers = parseCsvLine(lines[0], delimiter);
      const rows: string[][] = [];

      for (let i = 1; i < Math.min(lines.length, maxRows + 1); i++) {
        rows.push(parseCsvLine(lines[i], delimiter));
      }

      // 统计每列
      const columnStats: ColumnStats[] = [];

      for (let col = 0; col < headers.length; col++) {
        const values = rows.map((r) => r[col] || '').filter((v) => v.length > 0);
        const nullCount = rows.length - values.length;
        const uniqueValues = new Set(values);

        // 检测类型
        const numericValues = values
          .map((v) => parseFloat(v))
          .filter((n) => !isNaN(n));
        const isNumeric = numericValues.length > values.length * 0.8;

        const stats: ColumnStats = {
          name: headers[col],
          type: isNumeric ? 'number' : 'string',
          nonNullCount: values.length,
          nullCount,
          uniqueCount: uniqueValues.size,
        };

        if (isNumeric && numericValues.length > 0) {
          stats.min = Math.min(...numericValues);
          stats.max = Math.max(...numericValues);
          stats.mean =
            numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
        }

        // Top 5 值
        const valueCounts = new Map<string, number>();
        for (const v of values) {
          valueCounts.set(v, (valueCounts.get(v) || 0) + 1);
        }
        stats.topValues = Array.from(valueCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([value, count]) => ({ value: value.substring(0, 50), count }));

        columnStats.push(stats);
      }

      // 格式化输出
      const lines_out: string[] = [];
      lines_out.push(`📊 CSV 分析报告: ${filePath}`);
      lines_out.push(`总行数: ${rows.length}${lines.length - 1 > maxRows ? ` (截取前${maxRows}行)` : ''}`);
      lines_out.push(`列数: ${headers.length}`);
      lines_out.push('');

      for (const col of columnStats) {
        const typeIcon = col.type === 'number' ? '🔢' : '📝';
        lines_out.push(`${typeIcon} ${col.name} (${col.type})`);
        lines_out.push(`  非空: ${col.nonNullCount}, 空值: ${col.nullCount}, 唯一值: ${col.uniqueCount}`);
        if (col.type === 'number') {
          lines_out.push(`  范围: ${col.min?.toFixed(2)} ~ ${col.max?.toFixed(2)}, 均值: ${col.mean?.toFixed(2)}`);
        }
        if (col.topValues && col.topValues.length > 0) {
          lines_out.push(`  高频值: ${col.topValues.map((v) => `${v.value}(${v.count})`).join(', ')}`);
        }
        lines_out.push('');
      }

      // 数据质量提示
      const issues: string[] = [];
      for (const col of columnStats) {
        if (col.nullCount > rows.length * 0.3) {
          issues.push(`⚠️ ${col.name} 缺失率 ${(col.nullCount / rows.length * 100).toFixed(0)}%`);
        }
        if (col.type === 'number' && col.min !== undefined && col.max !== undefined) {
          const range = col.max - col.min;
          if (range === 0) {
            issues.push(`⚠️ ${col.name} 所有值相同（常量列）`);
          }
        }
      }

      if (issues.length > 0) {
        lines_out.push('数据质量提示:');
        issues.forEach((i) => lines_out.push(`  ${i}`));
      }

      return {
        success: true,
        output: lines_out.join('\n'),
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
          rows: rows.length,
          columns: headers.length,
          headers,
          columnStats: columnStats.map((c) => ({
            name: c.name,
            type: c.type,
            nullCount: c.nullCount,
            uniqueCount: c.uniqueCount,
          })),
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `CSV分析失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}
