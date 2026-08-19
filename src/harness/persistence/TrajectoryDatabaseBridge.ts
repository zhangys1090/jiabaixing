/**
 * Harness Layer 4: Persistence - Trajectory Database
 *
 * SQLite 轨迹持久化，完整记录 FC 循环执行轨迹
 */

import fs from 'fs';
import path from 'path';
import type { DatabaseAdapter } from '../../shared/DatabaseShim';
import { createDatabase } from '../../shared/DatabaseShim';
import { Logger } from '../../utils/Logger';

export interface ExecutionRecord {
  id: string;
  user_id?: string;
  input: string;
  response?: string;
  intent?: string;
  status: 'success' | 'failed' | 'aborted' | 'in_progress';
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
    | 'debating'
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

export interface LLMOutputRecord {
  id?: number;
  execution_id: string;
  step_index: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  model_name?: string;
  raw_output?: string;
  duration_ms?: number;
  created_at: number;
}

export interface EvaluationResultRecord {
  id?: number;
  execution_id: string;
  step_index: number;
  phase: string;
  task_completion?: number;
  data_groundedness?: number;
  safety_risk_level?: string;
  suggested_action?: string;
  goal_progress?: number;
  summary?: string;
  created_at: number;
}

export interface ExecutionStats {
  total: number;
  successRate: number;
  avgDuration: number;
  avgScore: number;
}

/**
 * @deprecated 已迁移 Python (`python/agent/persistence/trajectory.py`)。
 * 仅作本地回退存根；生产路径经 `PythonAgentBridge.getTrajectory()` 桥接。
 * `AgentHarness` 仍 `new TrajectoryDatabase()`，经 `TrajectoryDatabase.ts` 重导出壳
 * 解析为本类。
 */
export class TrajectoryDatabaseBridge {
  private db: DatabaseAdapter;
  private dbPath: string;
  /** P3: 嵌入函数 — 将文本转为向量 */
  private embedFunction: ((text: string) => number[]) | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = createDatabase(dbPath);
    if (this.db) {
      try {
        this.db.pragma('journal_mode = WAL');
      } catch {}
      this.initializeTables();
      Logger.info(
        `💾 TrajectoryDatabase 初始化: ${dbPath}`,
        'TrajectoryDatabase'
      );
    } else {
      Logger.warn(
        'TrajectoryDatabase: 降级为内存模式，轨迹数据不会被持久化',
        'TrajectoryDatabase'
      );
    }
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

      CREATE TABLE IF NOT EXISTS llm_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        model_name TEXT,
        raw_output TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS evaluation_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        phase TEXT NOT NULL,
        task_completion REAL,
        data_groundedness REAL,
        safety_risk_level TEXT,
        suggested_action TEXT,
        goal_progress REAL,
        summary TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_llm_outputs_execution_id ON llm_outputs(execution_id);
      CREATE INDEX IF NOT EXISTS idx_evaluation_results_execution_id ON evaluation_results(execution_id);
      CREATE INDEX IF NOT EXISTS idx_evaluation_results_safety ON evaluation_results(safety_risk_level);
    `);

    // P3: 添加 embedding 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE executions ADD COLUMN embedding TEXT;`);
    } catch {
      // 列已存在，忽略
    }
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

    // P3: 生成并存储 embedding
    if (this.embedFunction && exec.input) {
      try {
        const embedding = this.embedFunction(exec.input);
        const updateStmt = this.db.prepare(
          `UPDATE executions SET embedding = @embedding WHERE id = @id`
        );
        updateStmt.run({
          embedding: JSON.stringify(embedding),
          id: exec.id,
        });
      } catch (err) {
        Logger.debug(
          `TrajectoryDatabase embedding 生成失败: ${(err as Error).message}`,
          'TrajectoryDatabase'
        );
      }
    }
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

  recordLLMOutput(output: LLMOutputRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO llm_outputs (
        execution_id, step_index, prompt_tokens, completion_tokens,
        model_name, raw_output, duration_ms, created_at
      ) VALUES (
        @execution_id, @step_index, @prompt_tokens, @completion_tokens,
        @model_name, @raw_output, @duration_ms, @created_at
      )
    `);
    stmt.run({
      execution_id: output.execution_id,
      step_index: output.step_index,
      prompt_tokens: output.prompt_tokens || null,
      completion_tokens: output.completion_tokens || null,
      model_name: output.model_name || null,
      raw_output: output.raw_output || null,
      duration_ms: output.duration_ms || null,
      created_at: output.created_at,
    });
  }

  recordEvaluationResult(result: EvaluationResultRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO evaluation_results (
        execution_id, step_index, phase, task_completion, data_groundedness,
        safety_risk_level, suggested_action, goal_progress, summary, created_at
      ) VALUES (
        @execution_id, @step_index, @phase, @task_completion, @data_groundedness,
        @safety_risk_level, @suggested_action, @goal_progress, @summary, @created_at
      )
    `);
    stmt.run({
      execution_id: result.execution_id,
      step_index: result.step_index,
      phase: result.phase,
      task_completion: result.task_completion || null,
      data_groundedness: result.data_groundedness || null,
      safety_risk_level: result.safety_risk_level || null,
      suggested_action: result.suggested_action || null,
      goal_progress: result.goal_progress || null,
      summary: result.summary || null,
      created_at: result.created_at,
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

  getLLMOutputs(executionId: string): LLMOutputRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM llm_outputs WHERE execution_id = ? ORDER BY step_index, id'
    );
    return stmt.all(executionId) as LLMOutputRecord[];
  }

  getEvaluationResults(
    executionId: string,
    safetyRiskLevel?: string
  ): EvaluationResultRecord[] {
    if (safetyRiskLevel) {
      const stmt = this.db.prepare(
        'SELECT * FROM evaluation_results WHERE execution_id = ? AND safety_risk_level = ? ORDER BY step_index, id'
      );
      return stmt.all(executionId, safetyRiskLevel) as EvaluationResultRecord[];
    }
    const stmt = this.db.prepare(
      'SELECT * FROM evaluation_results WHERE execution_id = ? ORDER BY step_index, id'
    );
    return stmt.all(executionId) as EvaluationResultRecord[];
  }

  getFullTrace(executionId: string): {
    execution: ExecutionRecord | null;
    llmOutputs: LLMOutputRecord[];
    toolInvocations: ToolInvocationRecord[];
    evaluations: EvaluationResultRecord[];
    stateTransitions: StateTransitionRecord[];
    contextSnapshots: ContextSnapshotRecord[];
  } {
    return {
      execution: this.getExecution(executionId),
      llmOutputs: this.getLLMOutputs(executionId),
      toolInvocations: this.getToolInvocations(executionId),
      evaluations: this.getEvaluationResults(executionId),
      stateTransitions: this.getStateTransitions(executionId),
      contextSnapshots: this.getContextSnapshots(executionId),
    };
  }

  getTracesByDateRange(startTime: number, endTime: number): ExecutionRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM executions WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC'
    );
    return stmt.all(startTime, endTime) as ExecutionRecord[];
  }

  getTracesBySafetyRisk(riskLevel: string): ExecutionRecord[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT e.* FROM executions e
      INNER JOIN evaluation_results er ON e.id = er.execution_id
      WHERE er.safety_risk_level = ?
      ORDER BY e.created_at DESC
    `);
    return stmt.all(riskLevel) as ExecutionRecord[];
  }

  exportAuditLog(executionId: string): {
    execution: ExecutionRecord | null;
    llmOutputs: LLMOutputRecord[];
    toolInvocations: ToolInvocationRecord[];
    evaluations: EvaluationResultRecord[];
    stateTransitions: StateTransitionRecord[];
    contextSnapshots: ContextSnapshotRecord[];
    exportedAt: number;
  } {
    const trace = this.getFullTrace(executionId);
    return {
      ...trace,
      exportedAt: Date.now(),
    };
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

  querySimilarTasks(
    query: string,
    options?: {
      includeFailed?: boolean;
      maxResults?: number;
      minQualityScore?: number;
    }
  ): Array<{
    execution: ExecutionRecord;
    toolInvocations: ToolInvocationRecord[];
    similarity: number;
    relevanceScore: number;
  }> {
    const maxResults = options?.maxResults ?? 5;
    const includeFailed = options?.includeFailed ?? false;
    const minQualityScore = options?.minQualityScore ?? 0.7;
    const statusFilter = includeFailed ? '' : "AND status = 'success'";
    const qualityFilter =
      minQualityScore > 0 ? `AND quality_overall >= ${minQualityScore}` : '';
    const stmt = this.db.prepare(
      `SELECT * FROM executions WHERE input LIKE ? ${statusFilter} ${qualityFilter} ORDER BY created_at DESC LIMIT ?`
    );
    const keyword = `%${query.split(' ')[0]}%`;
    const rows = stmt.all(keyword, maxResults * 2) as ExecutionRecord[];

    const scored = rows.map((execution) => {
      let relevanceScore = 0.5;

      if (this.embedFunction && execution.input) {
        const inputEmbedding = this.embedFunction(query);
        const execEmbedding = this.getExecutionEmbedding(execution.id || '');
        if (execEmbedding && inputEmbedding) {
          const vectorSim = this.vectorCosineSimilarity(
            inputEmbedding,
            execEmbedding
          );
          relevanceScore += vectorSim * 0.5;
        }
      }

      if (execution.input) {
        const cosineSim = this.cosineSimilarity(query, execution.input);
        relevanceScore += cosineSim * 0.35;
      }

      const toolInvocations = execution.id
        ? this.getToolInvocations(execution.id)
        : [];

      return {
        execution,
        toolInvocations,
        similarity: relevanceScore,
        relevanceScore,
      };
    });

    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return scored.slice(0, maxResults);
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

  /**
   * P3: 设置嵌入函数 — 用于生成语义向量
   */
  setEmbedFunction(fn: (text: string) => number[]): void {
    this.embedFunction = fn;
    Logger.info('📐 TrajectoryDatabase 嵌入函数已设置', 'TrajectoryDatabase');
  }

  /** 获取执行的embedding */
  private getExecutionEmbedding(execId: string): number[] | null {
    try {
      const stmt = this.db.prepare(
        `SELECT embedding FROM executions WHERE id = ?`
      );
      const row = stmt.get(execId) as { embedding?: string } | undefined;
      if (row?.embedding) {
        return JSON.parse(row.embedding);
      }
    } catch {
      // 忽略
    }
    return null;
  }

  /** 向量余弦相似度 */
  private vectorCosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** 词频余弦相似度 */
  private cosineSimilarity(textA: string, textB: string): number {
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'shall',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'and',
      'or',
      'not',
      'no',
      'but',
      'if',
      'then',
      'than',
      '的',
      '了',
      '在',
      '是',
      '我',
      '有',
      '和',
      '就',
      '不',
      '人',
      '都',
      '一',
      '一个',
      '上',
      '也',
      '很',
      '到',
      '说',
      '要',
      '去',
    ]);
    const tokenize = (text: string): Map<string, number> => {
      const tokens = text
        .toLowerCase()
        .split(/[\s\-_./\\:;，。！？、()（）\[\]{}'"`]+/)
        .filter((w) => w.length > 1 && !stopWords.has(w));
      const freq = new Map<string, number>();
      for (const t of tokens) {
        freq.set(t, (freq.get(t) || 0) + 1);
      }
      return freq;
    };
    const freqA = tokenize(textA);
    const freqB = tokenize(textB);
    if (freqA.size === 0 || freqB.size === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (const [token, countA] of freqA) {
      normA += countA * countA;
      const countB = freqB.get(token) || 0;
      dotProduct += countA * countB;
    }
    for (const [, countB] of freqB) {
      normB += countB * countB;
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /** 保存环境状态快照 */
  saveEnvironmentState(state: Record<string, unknown>): void {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS environment_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`
      );
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO environment_state (id, state, updated_at) VALUES (1, ?, ?)`
      );
      stmt.run(JSON.stringify(state), Date.now());
    } catch {
      // 静默处理
    }
  }

  /** 加载环境状态快照 */
  loadEnvironmentState(): Record<string, unknown> | null {
    try {
      const stmt = this.db.prepare(
        `SELECT state FROM environment_state WHERE id = 1`
      );
      const row = stmt.get() as { state: string } | undefined;
      if (row?.state) {
        return JSON.parse(row.state);
      }
    } catch {
      // 静默处理
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // P2 #15: 时间预算预估 — 基于历史执行数据预测
  // ═══════════════════════════════════════════════════════════

  /**
   * 基于历史数据预估任务执行时间
   * @param taskType - 任务类型标识（如工具名、技能名）
   * @param complexity - 任务复杂度 (0-1)
   * @returns 预估时间及置信区间
   */
  estimateExecutionTime(
    taskType: string,
    complexity?: number
  ): {
    estimatedMs: number;
    p50: number;
    p90: number;
    p99: number;
    sampleCount: number;
    confidence: 'low' | 'medium' | 'high';
  } | null {
    try {
      const stmt = this.db.prepare(
        `SELECT total_duration, total_tool_calls, quality_overall
         FROM executions
         WHERE status = 'success' AND total_duration > 0
         ORDER BY created_at DESC
         LIMIT 200`
      );
      const rows = stmt.all() as Array<{
        total_duration: number;
        total_tool_calls: number;
        quality_overall: number | null;
      }>;

      if (rows.length < 3) {
        return null;
      }

      const durations = rows.map((r) => r.total_duration).sort((a, b) => a - b);
      const n = durations.length;

      const p50 = durations[Math.floor(n * 0.5)];
      const p90 = durations[Math.floor(n * 0.9)];
      const p99 = durations[Math.min(Math.floor(n * 0.99), n - 1)];

      const avgDuration = durations.reduce((a, b) => a + b, 0) / n;

      let estimatedMs = avgDuration;

      if (complexity !== undefined && complexity >= 0 && complexity <= 1) {
        const avgToolCalls =
          rows.reduce((a, r) => a + r.total_tool_calls, 0) / n;
        const complexityFactor = 0.5 + complexity * 1.5;
        estimatedMs = avgDuration * complexityFactor;

        if (avgToolCalls > 0) {
          const toolCallFactor = 1 + complexity * 0.3;
          estimatedMs *= toolCallFactor;
        }
      }

      let confidence: 'low' | 'medium' | 'high';
      if (n < 10) confidence = 'low';
      else if (n < 50) confidence = 'medium';
      else confidence = 'high';

      return {
        estimatedMs: Math.round(estimatedMs),
        p50,
        p90,
        p99,
        sampleCount: n,
        confidence,
      };
    } catch (error) {
      Logger.warn(
        `时间预算预估失败: ${(error as Error).message}`,
        'TrajectoryDatabase'
      );
      return null;
    }
  }

  /**
   * 按工具名预估执行时间
   */
  estimateToolTime(toolName: string): {
    estimatedMs: number;
    p50: number;
    p90: number;
    sampleCount: number;
  } | null {
    try {
      const stmt = this.db.prepare(
        `SELECT duration FROM tool_invocations
         WHERE tool_name = ? AND duration > 0
         ORDER BY created_at DESC
         LIMIT 100`
      );
      const rows = stmt.all(toolName) as Array<{ duration: number }>;

      if (rows.length < 2) return null;

      const durations = rows.map((r) => r.duration).sort((a, b) => a - b);
      const n = durations.length;
      const avg = durations.reduce((a, b) => a + b, 0) / n;

      return {
        estimatedMs: Math.round(avg),
        p50: durations[Math.floor(n * 0.5)],
        p90: durations[Math.floor(n * 0.9)],
        sampleCount: n,
      };
    } catch {
      return null;
    }
  }
}
