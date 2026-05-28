/**
 * Harness Tool: reminder_set - 提醒/闹钟设置
 */

import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';

interface ReminderEntry {
  id: string;
  message: string;
  triggerTime: string;
  repeat: string;
  status: 'pending' | 'triggered' | 'cancelled';
  createdAt: number;
}

export const REMINDER_SET_DEF: ToolDefinition = {
  name: 'reminder_set',
  description:
    '设置和管理定时提醒。仅在用户要求"定时提醒"、"到时间提醒我"、"设置闹钟"等需要时间触发的场景使用。不适用：单纯记住或存储信息（请用memory_store）、任务管理、笔记记录。',
  category: ToolCategory.DAILY,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['set', 'list', 'cancel'],
    },
    reminder_id: {
      type: 'string',
      description: '提醒ID',
    },
    message: {
      type: 'string',
      description: '提醒内容',
    },
    trigger_time: {
      type: 'string',
      description: '触发时间（ISO格式或自然语言如"3点"、"30分钟后"）',
    },
    repeat: {
      type: 'string',
      description: '重复方式',
      enum: ['none', 'daily', 'weekly', 'monthly'],
      default: 'none',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

export interface ReminderSetDeps {
  reminderStore: {
    getReminders(): Promise<ReminderEntry[]>;
    saveReminder(r: ReminderEntry): Promise<void>;
    deleteReminder(id: string): Promise<void>;
  };
  scheduleTrigger: ((reminder: ReminderEntry) => void) | null;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function parseTriggerTime(expr: string): string {
  const minuteMatch = expr.match(/(\d+)\s*分钟后/);
  if (minuteMatch) {
    const ms = parseInt(minuteMatch[1], 10) * 60 * 1000;
    return new Date(Date.now() + ms).toISOString();
  }
  const hourMatch = expr.match(/(\d+)\s*点/);
  if (hourMatch) {
    const hour = parseInt(hourMatch[1], 10);
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const parsed = Date.parse(expr);
  if (!isNaN(parsed)) return new Date(parsed).toISOString();
  return expr;
}

function formatReminderList(reminders: ReminderEntry[]): string {
  if (reminders.length === 0) return '暂无提醒';
  return reminders
    .map((r) => {
      const icon =
        r.status === 'pending' ? '🔔' : r.status === 'triggered' ? '✅' : '❌';
      const repeat = r.repeat !== 'none' ? ` 🔄${r.repeat}` : '';
      return `${icon} [${r.id}] ${r.message} ⏰${r.triggerTime}${repeat}`;
    })
    .join('\n');
}

export function createReminderSetExecutor(deps: ReminderSetDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');

    try {
      switch (action) {
        case 'set': {
          const message = String(params.message || '');
          const triggerTime = String(params.trigger_time || '');
          if (!message || !triggerTime) {
            return {
              success: false,
              output: null,
              error: '设置提醒需要提供message和trigger_time',
              duration: 0,
              validated: false,
            };
          }
          const reminder: ReminderEntry = {
            id: generateId(),
            message,
            triggerTime: parseTriggerTime(triggerTime),
            repeat: String(params.repeat || 'none'),
            status: 'pending',
            createdAt: Date.now(),
          };
          await deps.reminderStore.saveReminder(reminder);
          if (deps.scheduleTrigger) {
            deps.scheduleTrigger(reminder);
          }
          return {
            success: true,
            output: `提醒已设置: [${reminder.id}] ${reminder.message} ⏰${reminder.triggerTime}`,
            duration: 0,
            validated: false,
          };
        }

        case 'list': {
          const reminders = await deps.reminderStore.getReminders();
          return {
            success: true,
            output: formatReminderList(reminders),
            duration: 0,
            validated: false,
          };
        }

        case 'cancel': {
          const reminderId = String(params.reminder_id || '');
          if (!reminderId) {
            return {
              success: false,
              output: null,
              error: '取消提醒需要提供reminder_id',
              duration: 0,
              validated: false,
            };
          }
          const reminders = await deps.reminderStore.getReminders();
          const reminder = reminders.find((r) => r.id === reminderId);
          if (!reminder) {
            return {
              success: false,
              output: null,
              error: `提醒不存在: ${reminderId}`,
              duration: 0,
              validated: false,
            };
          }
          reminder.status = 'cancelled';
          await deps.reminderStore.saveReminder(reminder);
          return {
            success: true,
            output: `提醒已取消: [${reminder.id}] ${reminder.message}`,
            duration: 0,
            validated: false,
          };
        }

        default:
          return {
            success: false,
            output: null,
            error: `未知操作: ${action}`,
            duration: 0,
            validated: false,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `提醒操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
