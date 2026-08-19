/**
 * P1 #10: 动态优先级评分测试
 *
 * 验证 dynamicPriorityScore 的多因子评分逻辑
 */
import type { TaskEntry } from '../../../src/harness/tools/daily/task_manage';
import { dynamicPriorityScore } from '../../../src/harness/tools/daily/task_priority';

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: `task_${Math.random().toString(36).slice(2, 6)}`,
    title: '测试任务',
    description: '测试描述',
    status: 'pending',
    priority: 'medium',
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as TaskEntry;
}

describe('dynamicPriorityScore', () => {
  it('应对空任务列表返回空数组', () => {
    const result = dynamicPriorityScore([]);
    expect(result).toHaveLength(0);
  });

  it('应对中等优先级任务给出合理评分', () => {
    const tasks = [makeTask({ priority: 'medium' })];
    const result = dynamicPriorityScore(tasks);

    expect(result).toHaveLength(1);
    expect(result[0].score).toBeGreaterThan(0);
    expect(result[0].score).toBeLessThanOrEqual(1);
    expect(result[0].suggestedPriority).toBeDefined();
  });

  it('紧急优先级任务应比低优先级得分更高', () => {
    const urgentTask = makeTask({ priority: 'urgent' });
    const lowTask = makeTask({ priority: 'low' });

    const [urgentResult] = dynamicPriorityScore([urgentTask, lowTask]);
    const [, lowResult] = dynamicPriorityScore([urgentTask, lowTask]);

    expect(urgentResult.score).toBeGreaterThan(lowResult.score);
  });

  it('已过期任务应获得最高紧急度', () => {
    const overdueTask = makeTask({
      priority: 'medium',
      dueDate: new Date(Date.now() - 86400000).toISOString(),
    });
    const futureTask = makeTask({
      priority: 'medium',
      dueDate: new Date(Date.now() + 86400000 * 7).toISOString(),
    });

    const [overdueResult] = dynamicPriorityScore([overdueTask, futureTask]);
    const [, futureResult] = dynamicPriorityScore([overdueTask, futureTask]);

    expect(overdueResult.factors.urgency).toBeGreaterThan(
      futureResult.factors.urgency
    );
  });

  it('更多标签的任务应获得更高影响力分数', () => {
    const manyTagsTask = makeTask({
      priority: 'medium',
      tags: ['a', 'b', 'c', 'd', 'e'],
    });
    const noTagsTask = makeTask({ priority: 'medium', tags: [] });

    const [manyResult] = dynamicPriorityScore([manyTagsTask, noTagsTask]);
    const [, noResult] = dynamicPriorityScore([manyTagsTask, noTagsTask]);

    expect(manyResult.factors.impact).toBeGreaterThan(noResult.factors.impact);
  });

  it('等待时间越长的任务应获得更高等待分数', () => {
    const oldTask = makeTask({
      priority: 'medium',
      createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    });
    const newTask = makeTask({
      priority: 'medium',
      createdAt: new Date().toISOString(),
    });

    const [oldResult] = dynamicPriorityScore([oldTask, newTask]);
    const [, newResult] = dynamicPriorityScore([oldTask, newTask]);

    expect(oldResult.factors.waitTime).toBeGreaterThan(
      newResult.factors.waitTime
    );
  });

  it('高分任务应建议为 urgent', () => {
    const task = makeTask({
      priority: 'urgent',
      dueDate: new Date(Date.now() - 1000).toISOString(),
      tags: ['a', 'b', 'c', 'd', 'e'],
      createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    });

    const [result] = dynamicPriorityScore([task]);
    expect(result.suggestedPriority).toBe('urgent');
  });

  it('应返回所有评分因子', () => {
    const tasks = [makeTask()];
    const [result] = dynamicPriorityScore(tasks);

    expect(result.factors).toHaveProperty('urgency');
    expect(result.factors).toHaveProperty('impact');
    expect(result.factors).toHaveProperty('waitTime');
    expect(result.factors).toHaveProperty('basePriority');
  });

  it('评分应按权重计算', () => {
    const task = makeTask({ priority: 'high' });
    const [result] = dynamicPriorityScore([task]);

    const expectedScore =
      result.factors.urgency * 0.35 +
      result.factors.impact * 0.25 +
      result.factors.waitTime * 0.15 +
      result.factors.basePriority * 0.25;

    expect(result.score).toBeCloseTo(expectedScore, 5);
  });
});
