/**
 * Phase 1.3: Trajectory Persistence Tests
 *
 * 使用内存数据库测试轨迹持久化功能
 */

import { TrajectoryDatabase } from '../../src/harness/persistence/TrajectoryDatabase';
import { TrajectoryQueryService } from '../../src/harness/persistence/TrajectoryQueryService';

describe('TrajectoryDatabase', () => {
  let db: TrajectoryDatabase;

  beforeEach(() => {
    db = new TrajectoryDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('应该创建表结构成功', () => {
    const stats = db.getExecutionStats();
    expect(stats.total).toBe(0);
  });

  test('应该插入和查询 execution 记录', () => {
    const now = Date.now();
    const exec = {
      id: 'test-exec-1',
      user_id: 'user-123',
      input: '测试输入',
      response: '测试响应',
      intent: 'test',
      status: 'success' as const,
      quality_overall: 0.85,
      loop_rounds: 3,
      total_tool_calls: 12,
      total_duration: 1500,
      created_at: now,
      updated_at: now,
    };

    db.recordExecution(exec);

    const retrieved = db.getExecution('test-exec-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.input).toBe('测试输入');
    expect(retrieved?.status).toBe('success');
    expect(retrieved?.quality_overall).toBe(0.85);
  });

  test('应该更新 execution 状态', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'test-exec-2',
      input: '测试输入2',
      status: 'failed',
      created_at: now,
      updated_at: now,
    });

    db.updateExecutionStatus('test-exec-2', 'success', '更新后的响应');

    const retrieved = db.getExecution('test-exec-2');
    expect(retrieved?.status).toBe('success');
    expect(retrieved?.response).toBe('更新后的响应');
  });

  test('应该插入和查询 tool_invocation 记录', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'test-exec-3',
      input: '测试输入3',
      status: 'success',
      created_at: now,
      updated_at: now,
    });

    db.recordToolInvocation({
      execution_id: 'test-exec-3',
      step_index: 0,
      tool_name: 'file_read',
      args_json: '{"path": "/test.txt"}',
      result_success: 1,
      result_output: '文件内容',
      duration: 100,
      created_at: now,
    });

    db.recordToolInvocation({
      execution_id: 'test-exec-3',
      step_index: 1,
      tool_name: 'memory_search',
      args_json: '{"query": "test"}',
      result_success: 0,
      result_output: undefined,
      duration: 50,
      error_message: 'Not found',
      created_at: now,
    });

    const invocations = db.getToolInvocations('test-exec-3');
    expect(invocations).toHaveLength(2);
    expect(invocations[0].tool_name).toBe('file_read');
    expect(invocations[0].result_success).toBe(1);
    expect(invocations[1].tool_name).toBe('memory_search');
    expect(invocations[1].result_success).toBe(0);
  });

  test('应该插入和查询 state_transition 记录', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'test-exec-4',
      input: '测试输入4',
      status: 'success',
      created_at: now,
      updated_at: now,
    });

    db.recordStateTransition({
      execution_id: 'test-exec-4',
      from_state: 'planning',
      to_state: 'executing',
      reason: '计划完成',
      created_at: now,
    });

    db.recordStateTransition({
      execution_id: 'test-exec-4',
      from_state: 'executing',
      to_state: 'evaluating',
      created_at: now,
    });

    db.recordStateTransition({
      execution_id: 'test-exec-4',
      from_state: 'evaluating',
      to_state: 'completed',
      created_at: now,
    });

    const transitions = db.getStateTransitions('test-exec-4');
    expect(transitions).toHaveLength(3);
    expect(transitions[0].from_state).toBe('planning');
    expect(transitions[0].to_state).toBe('executing');
    expect(transitions[1].to_state).toBe('evaluating');
    expect(transitions[2].to_state).toBe('completed');
  });

  test('应该正确计算统计信息', () => {
    const now = Date.now();

    db.recordExecution({
      id: 'exec-1',
      input: '输入1',
      status: 'success',
      quality_overall: 0.9,
      total_duration: 1000,
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'exec-2',
      input: '输入2',
      status: 'success',
      quality_overall: 0.7,
      total_duration: 2000,
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'exec-3',
      input: '输入3',
      status: 'failed',
      created_at: now,
      updated_at: now,
    });

    const stats = db.getExecutionStats();
    expect(stats.total).toBe(3);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.avgDuration).toBe(1500);
    expect(stats.avgScore).toBe(0.8);
  });

  test('应该返回最近的执行记录', () => {
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      db.recordExecution({
        id: `exec-recent-${i}`,
        input: `输入${i}`,
        status: 'success',
        created_at: now - i * 1000,
        updated_at: now - i * 1000,
      });
    }

    const recent = db.getRecentExecutions(5);
    expect(recent).toHaveLength(5);
    expect(recent[0].id).toBe('exec-recent-0');
  });
});

describe('TrajectoryQueryService', () => {
  let db: TrajectoryDatabase;
  let queryService: TrajectoryQueryService;

  beforeEach(() => {
    db = new TrajectoryDatabase(':memory:');
    queryService = new TrajectoryQueryService(db);
  });

  afterEach(() => {
    db.close();
  });

  test('应该返回失败执行列表', () => {
    const now = Date.now();

    db.recordExecution({
      id: 'success-1',
      input: '成功任务',
      status: 'success',
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'failed-1',
      input: '失败任务',
      status: 'failed',
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'aborted-1',
      input: '中止任务',
      status: 'aborted',
      created_at: now,
      updated_at: now,
    });

    const failed = queryService.getFailedExecutions();
    expect(failed).toHaveLength(2);
    expect(failed.some((e) => e.id === 'failed-1')).toBe(true);
    expect(failed.some((e) => e.id === 'aborted-1')).toBe(true);
    expect(failed.some((e) => e.id === 'success-1')).toBe(false);
  });

  test('应该按类别过滤失败执行', () => {
    const now = Date.now();

    db.recordExecution({
      id: 'failed-file',
      input: '读取文件失败',
      status: 'failed',
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'failed-memory',
      input: '记忆搜索失败',
      status: 'failed',
      created_at: now,
      updated_at: now,
    });

    const fileFailed = queryService.getFailedExecutions({ category: '文件' });
    expect(fileFailed).toHaveLength(1);
    expect(fileFailed[0].id).toBe('failed-file');
  });

  test('应该计算工具成功率', () => {
    const now = Date.now();

    db.recordExecution({
      id: 'exec-1',
      input: '测试',
      status: 'success',
      created_at: now,
      updated_at: now,
    });

    db.recordToolInvocation({
      execution_id: 'exec-1',
      step_index: 0,
      tool_name: 'file_read',
      args_json: '{}',
      result_success: 1,
      duration: 100,
      created_at: now,
    });

    db.recordToolInvocation({
      execution_id: 'exec-1',
      step_index: 1,
      tool_name: 'file_read',
      args_json: '{}',
      result_success: 1,
      duration: 150,
      created_at: now,
    });

    db.recordToolInvocation({
      execution_id: 'exec-1',
      step_index: 2,
      tool_name: 'file_write',
      args_json: '{}',
      result_success: 0,
      duration: 200,
      error_message: 'Permission denied',
      created_at: now,
    });

    const rates = queryService.getToolSuccessRates();
    expect(rates['file_read']).toBeDefined();
    expect(rates['file_read'].total).toBe(2);
    expect(rates['file_read'].success).toBe(2);
    expect(rates['file_read'].rate).toBe(1);

    expect(rates['file_write']).toBeDefined();
    expect(rates['file_write'].total).toBe(1);
    expect(rates['file_write'].success).toBe(0);
    expect(rates['file_write'].rate).toBe(0);
  });

  test('应该计算每小时质量分布', () => {
    const now = Date.now();
    const baseDate = new Date(now);
    baseDate.setHours(10, 0, 0, 0);
    const hour10 = baseDate.getTime();

    db.recordExecution({
      id: 'exec-10am-1',
      input: '10点测试',
      status: 'success',
      quality_overall: 0.9,
      created_at: hour10,
      updated_at: hour10,
    });

    db.recordExecution({
      id: 'exec-10am-2',
      input: '10点测试2',
      status: 'success',
      quality_overall: 0.7,
      created_at: hour10 + 1000,
      updated_at: hour10 + 1000,
    });

    const hourly = queryService.getAverageQualityByHour();
    const hour10Data = hourly.find((h) => h.hour === 10);
    expect(hour10Data).toBeDefined();
    expect(hour10Data?.count).toBe(2);
    expect(hour10Data?.avgScore).toBe(0.8);
  });

  test('应该计算每日质量趋势', () => {
    const now = Date.now();

    for (let day = 0; day < 3; day++) {
      const dayTimestamp = now - day * 24 * 60 * 60 * 1000;
      db.recordExecution({
        id: `day-${day}-1`,
        input: `第${day}天`,
        status: 'success',
        quality_overall: 0.5 + day * 0.15,
        total_duration: 1000 + day * 500,
        created_at: dayTimestamp,
        updated_at: dayTimestamp,
      });
    }

    const trend = queryService.getRecentTrend(7);
    expect(trend).toHaveLength(3);
    expect(trend[0].date).toBeDefined();
    expect(trend[0].count).toBe(1);
  });
});
