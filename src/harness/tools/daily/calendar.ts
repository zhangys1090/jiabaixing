import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { ToolCategory } from '../../types';
import { withStoreLock } from './storeLock';

export const CALENDAR_DEF: ToolDefinition = {
  name: 'calendar',
  description:
    '日历日程管理。支持创建日程、查看日程、设置提醒、查询日程冲突等操作。适用场景：会议安排、日程管理、时间规划。',
  category: ToolCategory.DAILY,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: [
        'create_event',
        'list_events',
        'get_today',
        'get_week',
        'delete_event',
        'check_conflict',
        'set_reminder',
      ],
    },
    event_id: {
      type: 'string',
      description: '日程ID',
    },
    title: {
      type: 'string',
      description: '日程标题',
    },
    description: {
      type: 'string',
      description: '日程描述',
    },
    start_time: {
      type: 'string',
      description: '开始时间（ISO格式或自然语言）',
    },
    end_time: {
      type: 'string',
      description: '结束时间（ISO格式或自然语言）',
    },
    location: {
      type: 'string',
      description: '地点',
    },
    attendees: {
      type: 'array',
      description: '参会人员',
      items: { type: 'string', description: '人员姓名或邮箱' },
    },
    all_day: {
      type: 'boolean',
      description: '是否全天事件',
      default: false,
    },
    reminder_minutes: {
      type: 'number',
      description: '提前提醒分钟数',
      default: 15,
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [],
  riskLevel: 'low',
  idempotent: false,
  timeout: 5000,
};

interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees: string[];
  allDay: boolean;
  reminderMinutes: number;
  createdAt: number;
}

export interface CalendarDeps {
  calendarStore: {
    getEvents(): Promise<CalendarEvent[]>;
    saveEvent(event: CalendarEvent): Promise<void>;
    deleteEvent(id: string): Promise<void>;
  };
  scheduleReminder?: (event: CalendarEvent) => void;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function parseDateTime(expr: string): string {
  const todayMatch = expr.match(/今天(\s+下午)?(\s+(\d+)\s*点)?/);
  if (todayMatch) {
    const d = new Date();
    if (todayMatch[3]) {
      let hour = parseInt(todayMatch[3], 10);
      if (todayMatch[1] && hour < 12) hour += 12;
      d.setHours(hour, 0, 0, 0);
    }
    return d.toISOString();
  }

  const tomorrowMatch = expr.match(/明天(\s+下午)?(\s+(\d+)\s*点)?/);
  if (tomorrowMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (tomorrowMatch[3]) {
      let hour = parseInt(tomorrowMatch[3], 10);
      if (tomorrowMatch[1] && hour < 12) hour += 12;
      d.setHours(hour, 0, 0, 0);
    }
    return d.toISOString();
  }

  const dayMatch = expr.match(/(\d+)\s*(分钟|小时|天)后/);
  if (dayMatch) {
    const num = parseInt(dayMatch[1], 10);
    const unit = dayMatch[2];
    let ms = 0;
    switch (unit) {
      case '分钟':
        ms = num * 60 * 1000;
        break;
      case '小时':
        ms = num * 60 * 60 * 1000;
        break;
      case '天':
        ms = num * 24 * 60 * 60 * 1000;
        break;
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const parsed = Date.parse(expr);
  if (!isNaN(parsed)) return new Date(parsed).toISOString();
  return expr;
}

function formatDateTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  });
}

function getDayStart(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getDayEnd(date: Date): number {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function createCalendarExecutor(deps: CalendarDeps) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const action = String(params.action || '');

    if (!deps.calendarStore) {
      return {
        success: false,
        output: null,
        error:
          'calendar 不可用: calendarStore 未注入，请在 initHarness 中配置日程存储依赖',
        duration: 0,
        validated: false,
      };
    }

    try {
      switch (action) {
        case 'create_event': {
          const title = String(params.title || '');
          const startTime = String(params.start_time || '');
          if (!title) {
            return {
              success: false,
              output: null,
              error: '创建日程需要提供title',
              duration: 0,
              validated: false,
            };
          }
          if (!startTime) {
            return {
              success: false,
              output: null,
              error: '创建日程需要提供start_time',
              duration: 0,
              validated: false,
            };
          }

          const parsedStart = parseDateTime(startTime);
          let parsedEnd = parsedStart;
          if (params.end_time) {
            parsedEnd = parseDateTime(String(params.end_time));
          } else {
            const d = new Date(parsedStart);
            d.setHours(d.getHours() + 1);
            parsedEnd = d.toISOString();
          }

          const event: CalendarEvent = {
            id: generateId(),
            title,
            description: params.description
              ? String(params.description)
              : undefined,
            startTime: parsedStart,
            endTime: parsedEnd,
            location: params.location ? String(params.location) : undefined,
            attendees: Array.isArray(params.attendees)
              ? params.attendees.map(String)
              : [],
            allDay: params.all_day === true,
            reminderMinutes:
              typeof params.reminder_minutes === 'number'
                ? params.reminder_minutes
                : 15,
            createdAt: Date.now(),
          };

          return withStoreLock(deps.calendarStore, async () => {
            await deps.calendarStore.saveEvent(event);

            if (deps.scheduleReminder) {
              deps.scheduleReminder(event);
            }

            const timeDisplay = event.allDay
              ? formatDate(event.startTime)
              : `${formatDateTime(event.startTime)} - ${formatDateTime(event.endTime)}`;

            return {
              success: true,
              output:
                `📅 日程已创建: [${event.id}] ${event.title}\n` +
                `时间: ${timeDisplay}\n` +
                `${event.location ? `地点: ${event.location}\n` : ''}` +
                `${event.attendees.length > 0 ? `参会人员: ${event.attendees.join(', ')}\n` : ''}` +
                `提醒: ${event.reminderMinutes}分钟前`,
              duration: 0,
              validated: false,
            };
          });
        }

        case 'list_events': {
          const events = await deps.calendarStore.getEvents();
          if (events.length === 0) {
            return {
              success: true,
              output: `📭 暂无日程`,
              duration: 0,
              validated: false,
            };
          }

          const sorted = [...events].sort(
            (a, b) =>
              new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
          );
          const eventList = sorted
            .map((e) => {
              const timeDisplay = e.allDay
                ? formatDate(e.startTime)
                : `${formatDateTime(e.startTime)} - ${formatDateTime(e.endTime)}`;
              return `[${e.id}] ${e.title} | ${timeDisplay}`;
            })
            .join('\n');

          return {
            success: true,
            output: `📋 所有日程 (共${events.length}个):\n${eventList}`,
            duration: 0,
            validated: false,
          };
        }

        case 'get_today': {
          const today = new Date();
          const dayStart = getDayStart(today);
          const dayEnd = getDayEnd(today);

          const events = await deps.calendarStore.getEvents();
          const todayEvents = events.filter((e) => {
            const eventStart = new Date(e.startTime).getTime();
            return eventStart >= dayStart && eventStart <= dayEnd;
          });

          if (todayEvents.length === 0) {
            return {
              success: true,
              output: `📭 今日暂无日程`,
              duration: 0,
              validated: false,
            };
          }

          const sorted = [...todayEvents].sort(
            (a, b) =>
              new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
          );
          const eventList = sorted
            .map((e) => {
              const timeDisplay = e.allDay
                ? '全天'
                : `${formatDateTime(e.startTime)} - ${formatDateTime(e.endTime)}`;
              const loc = e.location ? ` @${e.location}` : '';
              return `${timeDisplay}${loc}: ${e.title}`;
            })
            .join('\n');

          return {
            success: true,
            output: `📅 今日日程 (${formatDate(today.toISOString())})\n\n${eventList}`,
            duration: 0,
            validated: false,
          };
        }

        case 'get_week': {
          const today = new Date();
          const dayOfWeek = today.getDay() || 7;
          const monday = new Date(today);
          monday.setDate(today.getDate() - dayOfWeek + 1);

          const weekEvents: Record<string, CalendarEvent[]> = {};
          const weekdays = [
            '周一',
            '周二',
            '周三',
            '周四',
            '周五',
            '周六',
            '周日',
          ];
          for (let i = 0; i < 7; i++) {
            const day = new Date(monday);
            day.setDate(monday.getDate() + i);
            weekEvents[weekdays[i]] = [];
          }

          const events = await deps.calendarStore.getEvents();
          for (const event of events) {
            const eventDate = new Date(event.startTime);
            const eventDayOfWeek = eventDate.getDay() || 7;
            const weekdayIndex = eventDayOfWeek - 1;
            if (weekdayIndex >= 0 && weekdayIndex < 7) {
              const weekStart = getDayStart(monday);
              const eventStart = new Date(event.startTime).getTime();
              if (
                eventStart >= weekStart &&
                eventStart < weekStart + 7 * 24 * 60 * 60 * 1000
              ) {
                weekEvents[weekdays[weekdayIndex]].push(event);
              }
            }
          }

          const weekEnd = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);
          let report = `📅 本周日程 (${formatDate(monday.toISOString())} ~ ${formatDate(weekEnd.toISOString())})\n\n`;
          for (const day of weekdays) {
            const dayEvents = weekEvents[day];
            if (dayEvents.length === 0) {
              report += `${day}: 空闲\n`;
            } else {
              const sorted = [...dayEvents].sort(
                (a, b) =>
                  new Date(a.startTime).getTime() -
                  new Date(b.startTime).getTime()
              );
              const eventLines = sorted
                .map((e) => {
                  const timeDisplay = e.allDay
                    ? '全天'
                    : formatDateTime(e.startTime);
                  return `  ${timeDisplay}: ${e.title}`;
                })
                .join('\n');
              report += `${day}:\n${eventLines}\n`;
            }
          }

          return {
            success: true,
            output: report,
            duration: 0,
            validated: false,
          };
        }

        case 'delete_event': {
          const eventId = String(params.event_id || '');
          if (!eventId) {
            return {
              success: false,
              output: null,
              error: '删除日程需要提供event_id',
              duration: 0,
              validated: false,
            };
          }

          return withStoreLock(deps.calendarStore, async () => {
            const events = await deps.calendarStore.getEvents();
            const event = events.find((e) => e.id === eventId);
            if (!event) {
              return {
                success: false,
                output: null,
                error: `日程不存在: ${eventId}`,
                duration: 0,
                validated: false,
              };
            }

            await deps.calendarStore.deleteEvent(eventId);

            return {
              success: true,
              output: `🗑️ 日程已删除: [${eventId}] ${event.title}`,
              duration: 0,
              validated: false,
            };
          });
        }

        case 'check_conflict': {
          const startTime = String(params.start_time || '');
          const endTime = String(params.end_time || '');
          if (!startTime) {
            return {
              success: false,
              output: null,
              error: '检查冲突需要提供start_time',
              duration: 0,
              validated: false,
            };
          }

          const parsedStart = new Date(parseDateTime(startTime)).getTime();
          let parsedEnd = parsedStart + 60 * 60 * 1000;
          if (endTime) {
            parsedEnd = new Date(parseDateTime(endTime)).getTime();
          }

          const events = await deps.calendarStore.getEvents();
          const conflicts = events.filter((e) => {
            const eStart = new Date(e.startTime).getTime();
            const eEnd = new Date(e.endTime).getTime();
            return !(parsedEnd <= eStart || parsedStart >= eEnd);
          });

          if (conflicts.length === 0) {
            return {
              success: true,
              output: `✅ 该时间段没有日程冲突`,
              duration: 0,
              validated: false,
            };
          }

          const conflictList = conflicts
            .map(
              (e) =>
                `${formatDateTime(e.startTime)} - ${formatDateTime(e.endTime)}: ${e.title}`
            )
            .join('\n');

          return {
            success: true,
            output: `⚠️ 发现 ${conflicts.length} 个日程冲突:\n${conflictList}`,
            duration: 0,
            validated: false,
          };
        }

        case 'set_reminder': {
          const eventId = String(params.event_id || '');
          const minutes =
            typeof params.reminder_minutes === 'number'
              ? params.reminder_minutes
              : 15;

          if (!eventId) {
            return {
              success: false,
              output: null,
              error: '设置提醒需要提供event_id',
              duration: 0,
              validated: false,
            };
          }

          return withStoreLock(deps.calendarStore, async () => {
            const events = await deps.calendarStore.getEvents();
            const event = events.find((e) => e.id === eventId);
            if (!event) {
              return {
                success: false,
                output: null,
                error: `日程不存在: ${eventId}`,
                duration: 0,
                validated: false,
              };
            }

            event.reminderMinutes = minutes;
            await deps.calendarStore.saveEvent(event);

            return {
              success: true,
              output: `🔔 提醒已设置: [${eventId}] ${event.title} 将在 ${minutes} 分钟前提醒`,
              duration: 0,
              validated: false,
            };
          });
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
        error: `日历操作失败: ${(err as Error).message}`,
        duration: 0,
        validated: false,
      };
    }
  };
}
