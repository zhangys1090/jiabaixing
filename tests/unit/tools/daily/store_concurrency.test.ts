/**
 * B-1 / B-4 jest 镜像 (CI 可跑; 本地 node_modules 损坏时由 .b1_verify/verify.cjs 运行时验证)。
 *
 * 覆盖:
 *  - B-1 (E3): task/note/calendar 并发 read-modify-write 经 per-store 互斥锁串行化,
 *            同 id 两处并发修改均落盘, 临界区顺序为 get→save→get→save(无交错)。
 *  - B-4 (E1): calendar 缺 calendarStore 守卫 → 诚实 success:false(不抛未捕获)。
 */
import { createTaskManageExecutor } from '../../../src/harness/tools/daily/task_manage';
import { createNoteTakeExecutor } from '../../../src/harness/tools/daily/note_take';
import { createCalendarExecutor } from '../../../src/harness/tools/daily/calendar';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function taskStore() {
  const map = new Map<string, any>();
  const events: string[] = [];
  return {
    events,
    getTasks: async () => {
      events.push('get');
      await sleep(5);
      return [...map.values()];
    },
    saveTask: async (t: any) => {
      events.push('save');
      await sleep(5);
      map.set(t.id, { ...t });
    },
    deleteTask: async (id: string) => {
      map.delete(id);
    },
    all: () => [...map.values()],
  };
}

function noteStore() {
  const map = new Map<string, any>();
  const events: string[] = [];
  return {
    events,
    getNotes: async () => {
      events.push('get');
      await sleep(5);
      return [...map.values()];
    },
    saveNote: async (n: any) => {
      events.push('save');
      await sleep(5);
      map.set(n.id, { ...n });
    },
    deleteNote: async (id: string) => {
      map.delete(id);
    },
    all: () => [...map.values()],
  };
}

function calendarStore() {
  const map = new Map<string, any>();
  const events: string[] = [];
  return {
    events,
    getEvents: async () => {
      events.push('get');
      await sleep(5);
      return [...map.values()];
    },
    saveEvent: async (e: any) => {
      events.push('save');
      await sleep(5);
      map.set(e.id, { ...e });
    },
    deleteEvent: async (id: string) => {
      map.delete(id);
    },
    all: () => [...map.values()],
  };
}

describe('B-1 并发 RMW 原子化 (per-store 互斥锁)', () => {
  it('task_manage 并发 update 同 id → 两处修改均保留 + 临界区串行化', async () => {
    const s = taskStore();
    const exec = createTaskManageExecutor({ taskStore: s });
    await s.saveTask({ id: 't1', title: 'A', priority: 'low', status: 'pending' });
    await Promise.all([
      exec({ action: 'update', task_id: 't1', title: 'B' }, {}),
      exec({ action: 'update', task_id: 't1', priority: 'high' }, {}),
    ]);
    const fin = s.all().find((t) => t.id === 't1');
    expect(fin.title).toBe('B');
    expect(fin.priority).toBe('high');
    expect(s.events.slice(1).join(',')).toBe('get,save,get,save');
  });

  it('note_take 并发 write 同 id → 两处修改均保留', async () => {
    const s = noteStore();
    const exec = createNoteTakeExecutor({ noteStore: s });
    await s.saveNote({ id: 'n1', title: 'A', content: 'x', tags: [], createdAt: 0, updatedAt: 0 });
    await Promise.all([
      exec({ action: 'write', note_id: 'n1', title: 'B' }, {}),
      exec({ action: 'write', note_id: 'n1', content: 'y' }, {}),
    ]);
    const fin = s.all().find((n) => n.id === 'n1');
    expect(fin.title).toBe('B');
    expect(fin.content).toBe('y');
  });

  it('calendar 并发 set_reminder 同 id → 修改生效 + 临界区串行化', async () => {
    const s = calendarStore();
    const exec = createCalendarExecutor({ calendarStore: s });
    await s.saveEvent({ id: 'e1', title: 'E', reminderMinutes: 15 });
    await Promise.all([
      exec({ action: 'set_reminder', event_id: 'e1', reminder_minutes: 30 }, {}),
      exec({ action: 'set_reminder', event_id: 'e1', reminder_minutes: 45 }, {}),
    ]);
    const fin = s.all().find((e) => e.id === 'e1');
    expect(fin.reminderMinutes).toBe(45);
    expect(s.events.slice(1).join(',')).toBe('get,save,get,save');
  });
});

describe('B-4 calendar deps 守卫', () => {
  it('缺 calendarStore → success:false 且不抛未捕获异常', async () => {
    const exec = createCalendarExecutor({});
    const r = await exec(
      { action: 'create_event', title: 'x', start_time: '2026-01-01T00:00:00Z' },
      {}
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/calendarStore 未注入/);
  });
});
