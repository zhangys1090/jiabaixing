/**
 * Tests for P2: Full Trace Audit System
 *
 * TDD approach:
 * - RED: Tests define expected audit capabilities
 * - GREEN: Implementation in TrajectoryDatabase
 * - REFACTOR: Ensure 132 harness tests still pass
 */

import { TrajectoryDatabase } from '../../src/harness/persistence/TrajectoryDatabase';
import fs from 'fs';
import path from 'path';

describe('P2: Full Trace Audit System', () => {
  let db: TrajectoryDatabase;
  const testDbPath = path.join(__dirname, 'test-audit-db.sqlite');

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    db = new TrajectoryDatabase(testDbPath);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('LLM Output Recording', () => {
    it('should record LLM output for each step', () => {
      const executionId = 'test-exec-001';

      db.recordExecution({
        id: executionId,
        input: '帮我查天气',
        status: 'in_progress',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordLLMOutput({
        execution_id: executionId,
        step_index: 0,
        prompt_tokens: 100,
        completion_tokens: 50,
        model_name: 'gpt-4',
        raw_output: '今天天气晴朗，温度25度',
        duration_ms: 500,
        created_at: Date.now(),
      });

      const outputs = db.getLLMOutputs(executionId);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].raw_output).toBe('今天天气晴朗，温度25度');
      expect(outputs[0].prompt_tokens).toBe(100);
      expect(outputs[0].completion_tokens).toBe(50);
    });

    it('should record multiple LLM outputs for multi-step execution', () => {
      const executionId = 'test-exec-002';

      db.recordExecution({
        id: executionId,
        input: '帮我创建文件并写入内容',
        status: 'in_progress',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      for (let i = 0; i < 3; i++) {
        db.recordLLMOutput({
          execution_id: executionId,
          step_index: i,
          prompt_tokens: 100 + i * 10,
          completion_tokens: 50 + i * 10,
          model_name: 'gpt-4',
          raw_output: `Step ${i} output`,
          duration_ms: 500 + i * 100,
          created_at: Date.now(),
        });
      }

      const outputs = db.getLLMOutputs(executionId);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].step_index).toBe(0);
      expect(outputs[2].step_index).toBe(2);
    });
  });

  describe('Evaluation Results Recording', () => {
    it('should record evaluation results for each step', () => {
      const executionId = 'test-exec-003';

      db.recordExecution({
        id: executionId,
        input: '测试任务',
        status: 'in_progress',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordEvaluationResult({
        execution_id: executionId,
        step_index: 0,
        phase: 'evaluating',
        task_completion: 0.8,
        data_groundedness: 0.9,
        safety_risk_level: 'none',
        suggested_action: 'continue',
        goal_progress: 0.8,
        summary: '任务进展良好',
        created_at: Date.now(),
      });

      const evaluations = db.getEvaluationResults(executionId);
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0].task_completion).toBe(0.8);
      expect(evaluations[0].suggested_action).toBe('continue');
      expect(evaluations[0].safety_risk_level).toBe('none');
    });

    it('should record critical safety evaluation', () => {
      const executionId = 'test-exec-004';

      db.recordExecution({
        id: executionId,
        input: '泄露密码',
        status: 'in_progress',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordEvaluationResult({
        execution_id: executionId,
        step_index: 0,
        phase: 'evaluating',
        task_completion: 0.5,
        data_groundedness: 0.7,
        safety_risk_level: 'critical',
        suggested_action: 'abort',
        goal_progress: 0.1,
        summary: '检测到严重安全风险',
        created_at: Date.now(),
      });

      const evaluations = db.getEvaluationResults(executionId);
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0].safety_risk_level).toBe('critical');
    });
  });

  describe('Full Trace Audit Query', () => {
    it('should retrieve complete trace for an execution', () => {
      const executionId = 'test-exec-005';

      db.recordExecution({
        id: executionId,
        input: '完整流程测试',
        response: '最终响应',
        status: 'success',
        quality_overall: 0.85,
        loop_rounds: 2,
        total_tool_calls: 3,
        total_duration: 5000,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordLLMOutput({
        execution_id: executionId,
        step_index: 0,
        model_name: 'gpt-4',
        raw_output: '第一步输出',
        duration_ms: 300,
        created_at: Date.now(),
      });

      db.recordToolInvocation({
        execution_id: executionId,
        step_index: 0,
        tool_name: 'file_list',
        args_json: '{"path": "."}',
        result_success: 1,
        result_output: '["file1.txt"]',
        duration: 100,
        created_at: Date.now(),
      });

      db.recordEvaluationResult({
        execution_id: executionId,
        step_index: 0,
        phase: 'evaluating',
        task_completion: 0.7,
        data_groundedness: 0.9,
        safety_risk_level: 'none',
        suggested_action: 'continue',
        goal_progress: 0.7,
        summary: '第一步完成',
        created_at: Date.now(),
      });

      const trace = db.getFullTrace(executionId);

      expect(trace.execution).not.toBeNull();
      expect(trace.execution!.input).toBe('完整流程测试');
      expect(trace.llmOutputs).toHaveLength(1);
      expect(trace.toolInvocations).toHaveLength(1);
      expect(trace.evaluations).toHaveLength(1);
    });

    it('should query traces by date range', () => {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

      db.recordExecution({
        id: 'exec-today',
        input: '今天的任务',
        status: 'success',
        created_at: now,
        updated_at: now,
      });

      db.recordExecution({
        id: 'exec-yesterday',
        input: '昨天的任务',
        status: 'success',
        created_at: oneDayAgo,
        updated_at: oneDayAgo,
      });

      db.recordExecution({
        id: 'exec-two-days-ago',
        input: '前天的任务',
        status: 'success',
        created_at: twoDaysAgo,
        updated_at: twoDaysAgo,
      });

      const recentTraces = db.getTracesByDateRange(oneDayAgo, now);
      expect(recentTraces.length).toBeGreaterThanOrEqual(2);
    });

    it('should query traces by safety risk level', () => {
      db.recordExecution({
        id: 'exec-critical-query',
        input: '危险任务',
        status: 'aborted',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordEvaluationResult({
        execution_id: 'exec-critical-query',
        step_index: 0,
        phase: 'evaluating',
        task_completion: 0.3,
        data_groundedness: 0.5,
        safety_risk_level: 'critical',
        suggested_action: 'abort',
        goal_progress: 0.1,
        summary: '严重风险',
        created_at: Date.now(),
      });

      const criticalTraces = db.getTracesBySafetyRisk('critical');
      expect(Array.isArray(criticalTraces)).toBe(true);
    });
  });

  describe('Plan-Execute-Evaluate Phases', () => {
    it('should track phase transitions in context snapshots', () => {
      const executionId = 'test-exec-006';

      db.recordExecution({
        id: executionId,
        input: '多阶段任务',
        status: 'in_progress',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordContextSnapshot({
        execution_id: executionId,
        phase: 'planning',
        step_index: 0,
        snapshot_json: JSON.stringify({ plan: ['步骤1', '步骤2'] }),
        duration_ms: 100,
        created_at: Date.now(),
      });

      db.recordContextSnapshot({
        execution_id: executionId,
        phase: 'executing',
        step_index: 1,
        snapshot_json: JSON.stringify({ action: '执行中' }),
        duration_ms: 500,
        created_at: Date.now(),
      });

      db.recordContextSnapshot({
        execution_id: executionId,
        phase: 'evaluating',
        step_index: 2,
        snapshot_json: JSON.stringify({ evaluation: '评估中' }),
        duration_ms: 200,
        created_at: Date.now(),
      });

      const allSnapshots = db.getContextSnapshots(executionId);
      expect(allSnapshots).toHaveLength(3);

      const planningSnapshots = allSnapshots.filter(s => s.phase === 'planning');
      const executingSnapshots = allSnapshots.filter(s => s.phase === 'executing');
      const evaluatingSnapshots = allSnapshots.filter(s => s.phase === 'evaluating');

      expect(planningSnapshots).toHaveLength(1);
      expect(executingSnapshots).toHaveLength(1);
      expect(evaluatingSnapshots).toHaveLength(1);
    });
  });

  describe('Audit Log Export', () => {
    it('should export audit log as structured JSON', () => {
      const executionId = 'test-exec-007';

      db.recordExecution({
        id: executionId,
        input: '审计测试',
        response: '审计响应',
        status: 'success',
        quality_overall: 0.9,
        loop_rounds: 1,
        total_tool_calls: 1,
        total_duration: 1000,
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      db.recordLLMOutput({
        execution_id: executionId,
        step_index: 0,
        model_name: 'gpt-4',
        raw_output: 'LLM输出',
        prompt_tokens: 50,
        completion_tokens: 30,
        duration_ms: 200,
        created_at: Date.now(),
      });

      db.recordToolInvocation({
        execution_id: executionId,
        step_index: 0,
        tool_name: 'test_tool',
        args_json: '{"param": "value"}',
        result_success: 1,
        result_output: 'tool result',
        duration: 100,
        created_at: Date.now(),
      });

      db.recordEvaluationResult({
        execution_id: executionId,
        step_index: 0,
        phase: 'evaluating',
        task_completion: 0.9,
        data_groundedness: 0.9,
        safety_risk_level: 'none',
        suggested_action: 'continue',
        goal_progress: 0.9,
        summary: '审计完成',
        created_at: Date.now(),
      });

      const auditLog = db.exportAuditLog(executionId);

      expect(auditLog.execution).toBeDefined();
      expect(auditLog.llmOutputs).toHaveLength(1);
      expect(auditLog.toolInvocations).toHaveLength(1);
      expect(auditLog.evaluations).toHaveLength(1);
      expect(auditLog.stateTransitions).toBeDefined();
    });
  });
});
