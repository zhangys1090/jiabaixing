/**
 * 自然语言调度工具 — 用中文描述时间，自动转为定时任务
 *
 * 从 Hermes 学到的核心原则：
 * - "每个工作日9点" 而不是 "0 9 * * 1-5"
 * - 用户说自然语言，系统处理 cron 转换
 * - 支持循环：每小时/每天/每周/每月
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';
import { Logger } from '../../../utils/Logger';

export const NATURAL_SCHEDULE_DEF: ToolDefinition = {
  name: 'natural_schedule',
  description:
    '用自然语言创建定时任务。USE WHEN: 用户说"每天早上9点"、"每周一"、"每小时"、"工作日提醒我"。DO NOT USE WHEN: 用户要设置一次性提醒（用reminder_set）。支持: 每天/每周/每小时/工作日/周末/自定义时间。',
  category: ToolCategory.DAILY,
  parameters: {
    description: {
      type: 'string',
      description: '要定时执行的任务描述',
    },
    schedule: {
      type: 'string',
      description: '自然语言时间描述，如"每天早上9点"、"每周一上午10点"、"每小时"',
    },
    enabled: {
      type: 'boolean',
      description: '是否立即启用',
      default: true,
    },
  },
  requiredParams: ['description', 'schedule'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: true,
  timeout: 10000,
};

interface ScheduledTask {
  id: string;
  description: string;
  schedule: string;
  cron: string;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
}

// 任务存储（内存 + 文件持久化）
const tasks: Map<string, ScheduledTask> = new Map();
const TASKS_FILE = require('path').join(process.cwd(), 'data', 'scheduled-tasks.json');

function loadTasks(): void {
  try {
    const fs = require('fs');
    if (fs.existsSync(TASKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
      for (const task of data) {
        tasks.set(task.id, task);
      }
    }
  } catch { /* 静默失败 */ }
}

function saveTasks(): void {
  try {
    const fs = require('fs');
    const dir = require('path').dirname(TASKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TASKS_FILE, JSON.stringify(Array.from(tasks.values()), null, 2), 'utf-8');
  } catch { /* 静默失败 */ }
}

// 初始化加载
loadTasks();

/**
 * 自然语言 → cron 表达式转换
 */
function parseNaturalSchedule(input: string): { cron: string; description: string } | null {
  const text = input.toLowerCase().trim();

  // 每天/每日
  const dailyMatch = text.match(/每天|每日/);
  if (dailyMatch) {
    const timeMatch = extractTime(text);
    if (timeMatch) {
      return { cron: `${timeMatch.minute} ${timeMatch.hour} * * *`, description: `每天 ${timeMatch.hour}:${String(timeMatch.minute).padStart(2, '0')}` };
    }
    return { cron: '0 9 * * *', description: '每天 09:00' };
  }

  // 工作日
  const weekdayMatch = text.match(/工作日|周一到周五|weekday/);
  if (weekdayMatch) {
    const timeMatch = extractTime(text);
    if (timeMatch) {
      return { cron: `${timeMatch.minute} ${timeMatch.hour} * * 1-5`, description: `工作日 ${timeMatch.hour}:${String(timeMatch.minute).padStart(2, '0')}` };
    }
    return { cron: '0 9 * * 1-5', description: '工作日 09:00' };
  }

  // 周末
  const weekendMatch = text.match(/周末|周六周日|weekend/);
  if (weekendMatch) {
    const timeMatch = extractTime(text);
    if (timeMatch) {
      return { cron: `${timeMatch.minute} ${timeMatch.hour} * * 0,6`, description: `周末 ${timeMatch.hour}:${String(timeMatch.minute).padStart(2, '0')}` };
    }
    return { cron: '0 10 * * 0,6', description: '周末 10:00' };
  }

  // 每周X
  const weeklyMatch = text.match(/每周([一二三四五六日天])/);
  if (weeklyMatch) {
    const dayMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const day = dayMap[weeklyMatch[1]] ?? 1;
    const timeMatch = extractTime(text);
    if (timeMatch) {
      return { cron: `${timeMatch.minute} ${timeMatch.hour} * * ${day}`, description: `每周${weeklyMatch[1]} ${timeMatch.hour}:${String(timeMatch.minute).padStart(2, '0')}` };
    }
    return { cron: `0 9 * * ${day}`, description: `每周${weeklyMatch[1]} 09:00` };
  }

  // 每小时
  const hourlyMatch = text.match(/每小时|每隔一小时|every hour/);
  if (hourlyMatch) {
    return { cron: '0 * * * *', description: '每小时' };
  }

  // 每N分钟
  const minuteMatch = text.match(/每(\d+)分钟/);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1]);
    return { cron: `*/${n} * * * *`, description: `每${n}分钟` };
  }

  // 每月X号
  const monthlyMatch = text.match(/每月(\d+)[号日]/);
  if (monthlyMatch) {
    const day = parseInt(monthlyMatch[1]);
    const timeMatch = extractTime(text);
    if (timeMatch) {
      return { cron: `${timeMatch.minute} ${timeMatch.hour} ${day} * *`, description: `每月${day}号 ${timeMatch.hour}:${String(timeMatch.minute).padStart(2, '0')}` };
    }
    return { cron: `0 9 ${day} * *`, description: `每月${day}号 09:00` };
  }

  // 早上/上午/中午/下午/晚上 + 时间
  const timeMatch = extractTime(text);
  if (timeMatch) {
    return { cron: `${timeMatch.minute} ${timeMatch.hour} * * *`, description: `每天 ${timeMatch.hour}:${String(timeMatch.minute).padStart(2, '0')}` };
  }

  return null;
}

function extractTime(text: string): { hour: number; minute: number } | null {
  // "早上9点" / "上午10点30" / "下午3点" / "晚上8点半"
  const match = text.match(/(早上|上午|中午|下午|晚上|凌晨)?(\d{1,2})[点时:：](\d{1,2})?(半)?/);
  if (match) {
    let hour = parseInt(match[2]);
    let minute = match[3] ? parseInt(match[3]) : (match[4] ? 30 : 0);

    // 上午/下午转换
    const period = match[1];
    if (period === '下午' || period === '晚上') {
      if (hour < 12) hour += 12;
    } else if (period === '凌晨') {
      // 保持不变
    } else if (period === '中午') {
      hour = 12;
    }

    return { hour: Math.min(23, hour), minute: Math.min(59, minute) };
  }

  // "9:30" / "09:00"
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    return { hour: parseInt(timeMatch[1]), minute: parseInt(timeMatch[2]) };
  }

  return null;
}

export function createNaturalScheduleExecutor() {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const description = String(params.description || '');
    const schedule = String(params.schedule || '');
    const enabled = params.enabled !== false;

    try {
      if (!description || !schedule) {
        return {
          success: false,
          output: null,
          error: '请提供任务描述和时间安排',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const parsed = parseNaturalSchedule(schedule);
      if (!parsed) {
        return {
          success: false,
          output: null,
          error: `无法理解时间描述: "${schedule}"。请使用如"每天早上9点"、"每周一"、"每小时"等格式。`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const id = `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const task: ScheduledTask = {
        id,
        description,
        schedule,
        cron: parsed.cron,
        enabled,
        createdAt: Date.now(),
        nextRun: calculateNextRun(parsed.cron),
      };

      tasks.set(id, task);
      saveTasks();

      // 注册到 EventBus
      const { EventBus } = await import('../../../shared/EventBus');
      Logger.info(
        `📅 自然语言调度: "${description}" → ${parsed.cron} (${parsed.description})`,
        'NaturalSchedule'
      );

      return {
        success: true,
        output: `✅ 定时任务已创建:\n\n任务: ${description}\n时间: ${parsed.description} (${parsed.cron})\n状态: ${enabled ? '已启用' : '已暂停'}\nID: ${id}\n\n使用 /schedule 命令管理定时任务。`,
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
          taskId: id,
          cron: parsed.cron,
          description: parsed.description,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `创建定时任务失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

function calculateNextRun(cron: string): number {
  // 简单的下次运行时间计算
  const parts = cron.split(' ');
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0);
  next.setMilliseconds(0);

  if (parts[0] !== '*') next.setMinutes(parseInt(parts[0]));
  if (parts[1] !== '*') next.setHours(parseInt(parts[1]));

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime();
}
