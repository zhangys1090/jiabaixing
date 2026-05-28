/**
 * Harness Layer 4: Persistence - Trajectory Database
 *
 * SQLite 轨迹持久化，完整记录 FC 循环执行轨迹
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';

export interface ExecutionRecord {
  id: string;
  user_id?: string;
  input: string;
  response?: string;
  intent?: string;
  status: 'success' | 'failed' | 'aborted';
  quality_overall?: number;
  loop_rounds?: number;
  total_tool_calls?: number;
  total_duration?: number;
  created_at: number;
  updated_at: number;
}

export interface ToolInvocationRecord {
  id?: number;
  execution_id: string;
  step_index: number;
  tool_name: string;
  args_json: string;
  result_success: number;
  result_output?: string;
  duration: number;
  error_message?: string;
  created_at: number;
}

export interface StateTransitionRecord {
  id?: number;
  execution_id: string;
  from_state: string;
  to_state: string;
  reason?: string;
  created_at: number;
}

export interface ContextSnapshotRecord {
  id?: number;
  execution_id: string;
  phase:
    | 'planning'
    | 'executing'
    | 'evaluating'
    | 'reporting'
    | 'tool_call'
    | 'tool_result'
    | 'llm_call';
  step_index: number;
  snapshot_json: string;
  token_count?: number;
  duration_ms?: number;
  created_at: number;
}

export interface ExecutionStats {
  total: number;
  successRate: number;
  avgDuration: number;
  avgScore: number;
}

export class TrajectoryDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
    Logger.info(
      `💾 TrajectoryDatabase 初始化: ${dbPath}`,
      'TrajectoryDatabase'
    );
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        input TEXT NOT NULL,
        response TEXT,
        intent TEXT,
        status TEXT NOT NULL DEFAULT 'failed',
        quality_overall REAL,
        loop_rounds INTEGER DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        total_duration INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_invocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_success INTEGER NOT NULL DEFAULT 0,
        result_output TEXT,
        duration INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS context_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        token_count INTEGER,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tool_invocations_execution_id ON tool_invocations(execution_id);
      CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool_name ON tool_invocations(tool_name);
      CREATE INDEX IF NOT EXISTS idx_state_transitions_execution_id ON state_transitions(execution_id);
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_execution_id ON context_snapshots(execution_id);
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_phase ON context_snapshots(phase);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
      CREATE INDEX IF NOT EXISTS idx_executions_created_at ON executions(created_at);
    `);
  }

  recordExecution(exec: ExecutionRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO executions (
        id, user_id, input, response, intent, status, quality_overall,
        loop_rounds, total_tool_calls, total_duration, created_at, updated_at
      ) VALUES (
        @id, @user_id, @input, @response, @intent, @status, @quality_overall,
        @loop_rounds, @total_tool_calls, @total_duration, @created_at, @updated_at
      )
    `);
    stmt.run({
      id: exec.id,
      user_id: exec.user_id || null,
      input: exec.input,
      response: exec.response || null,
      intent: exec.intent || null,
      status: exec.status,
      quality_overall: exec.quality_overall || null,
      loop_rounds: exec.loop_rounds || 0,
      total_tool_calls: exec.total_tool_calls || 0,
      total_duration: exec.total_duration || 0,
      created_at: exec.created_at,
      updated_at: exec.updated_at,
    });
  }

  updateExecutionStatus(id: string, status: string, response?: string): void {
    const stmt = this.db.prepare(`
      UPDATE executions
      SET status = @status, response = @response, updated_at = @updated_at
      WHERE id = @id
    `);
    stmt.run({
      id,
      status,
      response: response || null,
      updated_at: Date.now(),
    });
  }

  recordToolInvocation(invocation: ToolInvocationRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_invocations (
        execution_id, step_index, tool_name, args_json, result_success,
        result_output, duration, error_message, created_at
      ) VALUES (
        @execution_id, @step_index, @tool_name, @args_json, @result_success,
        @result_output, @duration, @error_message, @created_at
      )
    `);
    stmt.run({
      execution_id: invocation.execution_id,
      step_index: invocation.step_index,
      tool_name: invocation.tool_name,
      args_json: invocation.args_json,
      result_success: invocation.result_success,
      result_output: invocation.result_output || null,
      duration: invocation.duration,
      error_message: invocation.error_message || null,
      created_at: invocation.created_at,
    });
  }

  recordStateTransition(transition: StateTransitionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO state_transitions (
        execution_id, from_state, to_state, reason, created_at
      ) VALUES (
        @execution_id, @from_state, @to_state, @reason, @created_at
      )
    `);
    stmt.run({
      execution_id: transition.execution_id,
      from_state: transition.from_state,
      to_state: transition.to_state,
      reason: transition.reason || null,
      created_at: transition.created_at,
    });
  }

  recordContextSnapshot(snapshot: ContextSnapshotRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO context_snapshots (
        execution_id, phase, step_index, snapshot_json, token_count, duration_ms, created_at
      ) VALUES (
        @execution_id, @phase, @step_index, @snapshot_json, @token_count, @duration_ms, @created_at
      )
    `);
    stmt.run({
      execution_id: snapshot.execution_id,
      phase: snapshot.phase,
      step_index: snapshot.step_index,
      snapshot_json: snapshot.snapshot_json,
      token_count: snapshot.token_count || null,
      duration_ms: snapshot.duration_ms || null,
      created_at: snapshot.created_at,
    });
  }

  getContextSnapshots(
    executionId: string,
    phase?: string
  ): ContextSnapshotRecord[] {
    if (phase) {
      const stmt = this.db.prepare(
        'SELECT * FROM context_snapshots WHERE execution_id = ? AND phase = ? ORDER BY step_index, id'
      );
      return stmt.all(executionId, phase) as ContextSnapshotRecord[];
    }
    const stmt = this.db.prepare(
      'SELECT * FROM context_snapshots WHERE execution_id = ? ORDER BY step_index, id'
    );
    return stmt.all(executionId) as ContextSnapshotRecord[];
  }

  getExecution(id: string): ExecutionRecord | null {
    const stmt = this.db.prepare('SELECT * FROM executions WHERE id = ?');
    return (stmt.get(id) as ExecutionRecord) || null;
  }

  getToolInvocations(executionId: string): ToolInvocationRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM tool_invocations WHERE execution_id = ? ORDER BY step_index, id'
    );
    return stmt.all(executionId) as ToolInvocationRecord[];
  }

  getStateTransitions(executionId: string): StateTransitionRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM state_transitions WHERE execution_id = ? ORDER BY id'
    );
    return stmt.all(executionId) as StateTransitionRecord[];
  }

  getRecentExecutions(limit: number): ExecutionRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM executions ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(limit) as ExecutionRecord[];
  }

  getExecutionStats(): ExecutionStats {
    const totalStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM executions'
    );
    const totalResult = totalStmt.get() as { count: number } | undefined;
    const total = totalResult?.count ?? 0;

    if (total === 0) {
      return { total: 0, successRate: 0, avgDuration: 0, avgScore: 0 };
    }

    const successStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM executions WHERE status = 'success'"
    );
    const successResult = successStmt.get() as { count: number } | undefined;
    const successCount = successResult?.count ?? 0;
    const successRate = successCount / total;

    const avgDurationStmt = this.db.prepare(
      'SELECT AVG(total_duration) as avg FROM executions WHERE total_duration > 0'
    );
    const avgDurationResult = avgDurationStmt.get() as
      | { avg: number | null }
      | undefined;
    const avgDuration = avgDurationResult?.avg ?? 0;

    const avgScoreStmt = this.db.prepare(
      'SELECT AVG(quality_overall) as avg FROM executions WHERE quality_overall IS NOT NULL'
    );
    const avgScoreResult = avgScoreStmt.get() as
      | { avg: number | null }
      | undefined;
    const avgScore = avgScoreResult?.avg ?? 0;

    return { total, successRate, avgDuration, avgScore };
  }

  close(): void {
    this.db.close();
    Logger.info('💾 TrajectoryDatabase 已关闭', 'TrajectoryDatabase');
  }
}
