import type { FeedbackSignal } from '../evolution/ImplicitFeedbackCollector';

interface HealingResult {
  success: boolean;
  type: string;
  description: string;
  before?: string;
  after?: string;
  error?: string;
}

interface RefactoringResult {
  success: boolean;
  description: string;
  changes?: Array<{ file: string; type: string }>;
  error?: string;
}

interface EnhancementResult {
  success: boolean;
  type: string;
  description: string;
  error?: string;
}

export interface CoreEvents {
  user_input: [payload: { input: string; userId?: string; traceId?: string }];
  task_completed: [
    payload: {
      taskId: string;
      traceId?: string;
      status: string;
      result?: unknown;
    },
  ];
  task_started: [payload: { taskId: string; taskName: string }];
  task_failed: [payload: { taskId: string; traceId?: string; error: string }];
  context_update: [key: string, value: unknown];
  response_ready: [
    payload: {
      response: string;
      traceId: string;
      success?: boolean;
      duration?: number;
      error?: string;
      ws?: unknown;
    },
  ];
  stream_start: [
    payload: {
      traceId: string;
      totalLength: number;
      timestamp: number;
    },
  ];
  stream_chunk: [
    payload: {
      traceId: string;
      chunk: string;
      offset: number;
      timestamp: number;
    },
  ];
  stream_done: [
    payload: {
      traceId: string;
      fullText: string;
      timestamp: number;
    },
  ];
  system_status: [status: string, detail?: string];
  command_executed: [command: string, result: unknown];
  context_switch: [fromScene: string, toScene: string];
  active_interaction: [
    data: { input?: string; userId?: string; text?: string },
  ];
}

export interface FileWatchEvents {
  file_changed: [
    payload: {
      filePath: string;
      changeType: 'created' | 'modified' | 'deleted' | 'renamed';
      timestamp: string;
      matchedRules: Array<{ id: string; name: string; action: string }>;
    },
  ];
  file_watch_started: [payload: { directories: string[]; timestamp: string }];
  file_watch_stopped: [payload: { timestamp: string }];
  file_change_rule_triggered: [
    payload: {
      ruleId: string;
      ruleName: string;
      action: string;
      filePath: string;
      timestamp: string;
    },
  ];
}

export interface SchedulerEvents {
  scheduler_started: [payload: { timestamp: string }];
  scheduler_stopped: [payload: { timestamp: string }];
  environment_update: [
    payload: {
      timestamp?: string;
      activeEnv?: string;
      foregroundWindow?: { title: string; process: string } | null;
    },
  ];
  project_change: [
    payload: { type: string; repo: string; detail: string; timestamp: string },
  ];
  git_status: [
    payload: {
      timestamp: string;
      repos: Array<{
        repo: string;
        branch: string;
        hasUncommitted: boolean;
        uncommittedFiles: number;
        aheadCount: number;
        behindCount: number;
      }>;
    },
  ];
  proactive_trigger: [
    payload: {
      type: string;
      reason: string;
      priority: number;
      suggestedAction?: string;
      context?: Record<string, unknown>;
    },
  ];
  schedule_check: [scheduleId: string, time: Date];
  skill_discovery: [
    payload: {
      timestamp: string;
      skillsDir: string;
      skillCount: number;
      skills: Array<{ name: string; path: string }>;
    },
  ];
  task_created_from_natural_language: [
    payload: {
      taskId: string;
      cronExpression: string;
      taskDescription: string;
      platform?: string;
      timestamp: string;
    },
  ];
  scheduled_task_completed: [
    payload: {
      taskId: string;
      taskName: string;
      success: boolean;
      executionTime: number;
      timestamp: string;
      error?: string;
    },
  ];
  job_completed: [
    payload: {
      jobId: string;
      success: boolean;
      duration: number;
      error?: string;
      timestamp: string;
    },
  ];
  job_failed: [
    payload: {
      jobId: string;
      success: boolean;
      duration: number;
      error: string;
      timestamp: string;
    },
  ];
}

export interface ProactiveEvents {
  proactive_schedule: [
    payload: { type: string; content: string; priority?: string },
  ];
  proactive_briefing: [payload: { type: string; context: string }];
  proactive_reminder: [payload: { type: string; message: string }];
  proactive_comfort: [
    payload: {
      type: string;
      emotionTypes?: string;
      intensity?: number;
      message: string;
    },
  ];
  proactive_checkin: [
    payload: { type: string; silenceHours?: number; message: string },
  ];
  proactive_behavior: [
    payload: { pattern: string; confidence: number; message: string },
  ];
  proactive_interaction: [
    payload: {
      reason: string;
      context?: string;
      scene?: string;
      priority?: string;
      isEmotionBased?: boolean;
    },
  ];
}

export interface MemoryEvents {
  memory_stored: [memoryId: string, type: string];
  memory_context_ready: [context: unknown];
  memory_context_request: [query: string];
  memory_update: [memoryId: string, content: unknown];
  memory_consolidation: [
    payload: { consolidatedCount: number; timestamp: string },
  ];
}

export interface EvolutionEvents {
  evolution_started: [optimizationId: string];
  evolution_update: [
    data: {
      version?: string;
      status?: string;
      description?: string;
      metrics?: Record<string, number>;
    },
  ];
  evolution_event: [
    payload: {
      type:
        | 'quality_assessed'
        | 'micro_optimization'
        | 'deep_optimization'
        | 'strategy_updated'
        | 'threshold_adjusted';
      traceId?: string;
      score?: number;
      description: string;
      metrics?: Record<string, number>;
      timestamp: string;
    },
  ];
  evolution_cycle_completed: [
    payload: {
      healingSuccess: number;
      refactorSuccess: boolean;
      enhancementSuccess: number;
    },
  ];
  weight_changed: [toolId: string, oldWeight: number, newWeight: number];
  weight_update: [data: { weights?: Record<string, number> }];
  'healing:success': [payload: HealingResult];
  'healing:failed': [payload: HealingResult];
  'refactoring:success': [payload: RefactoringResult];
  'enhancement:success': [payload: EnhancementResult];
  self_healing_completed: [
    payload: { total: number; success: number; results: HealingResult[] },
  ];
  self_refactor_completed: [payload: RefactoringResult];
  self_enhancement_completed: [
    payload: { total: number; success: number; results: EnhancementResult[] },
  ];
  proactive_evolution_completed: [
    payload: {
      cause: string;
      action: string;
      result: string;
      timestamp: string;
    },
  ];
  learning_signal: [
    payload: {
      signalType: 'positive' | 'negative' | 'task_success' | 'task_failure';
      toolName?: string;
      error?: string;
      quality?: number;
      duration?: number;
      userInput?: string;
      toolCount?: number;
      timestamp: number;
    },
  ];
}

export interface OptimizationEvents {
  feedback_collected: [
    payload: {
      traceId: string;
      feedbackRecorded: boolean;
      memoryUpdated: boolean;
      evolutionTriggered: boolean;
      sovereigntyAudited: boolean;
      timestamp: string;
    },
  ];
  optimization_update: [
    payload: {
      id: string;
      timestamp: number;
      toneAdjustments: unknown[];
      skillWeights: Record<string, number>;
      promptExamples: unknown[];
    },
  ];
  optimization_cycle_completed: [
    payload: {
      cycleId: string;
      improvements: number;
      timestamp: number;
      results?: unknown[];
      overallScore?: number;
    },
  ];
  optimization_requested: [
    payload: {
      requestId: string;
      target: string;
      priority: 'high' | 'medium' | 'low';
    },
  ];
}

export interface ResourceEvents {
  resource_warning: [resourceType: string, usage: number];
  llm_model_unavailable: [error: string];
  feedback_signal: [traceId: string, feedbackType: string, score?: number];
  capability_metrics: [
    payload: { capability: string; score: number; timestamp: string },
  ];
  memory_warning: [
    payload: {
      warnings: string[];
      stats: {
        heapUsedMB: number;
        heapTotalMB: number;
        rssMB: number;
        externalMB: number;
      };
      timestamp: string;
    },
  ];
  token_quota_warning: [
    payload: {
      sessionId: string;
      usagePercent: number;
      totalTokens: number;
      maxTokens: number;
      timestamp: string;
    },
  ];
}

export interface UserEvents {
  user_correction: [
    payload: {
      toolId?: string;
      tool_name?: string;
      correctionType?: string;
      type?: string;
      reason?: string;
      message?: string;
      severity?: number;
      traceId?: string;
      trace_id?: string;
    },
  ];
  emotion_detected: [emotion: string, intensity: number];
  emotion_analysis: [
    payload: {
      emotion: string;
      intensity: number;
      trend?: string;
      timestamp: string;
    },
  ];
  /** D2 认知总线：认知类工具（emotion_detect/self_reflect 等）执行完毕后的结构化结果，
   *  供 ReAct 循环的情绪/反思总线消费，驱动策略调整（如高负向情绪降速、反思建议进 evolution）。 */
  cognition_result: [
    payload: {
      tool: string;
      category: string;
      success: boolean;
      durationMs: number;
      outputPreview?: string | null;
      error?: string | null;
      timestamp: string;
      sessionId: string | null;
      text?: string;
      language?: string;
      confidence?: number;
    },
  ];
  behavior_analysis: [
    payload: { patterns: string[]; confidence: number; timestamp: string },
  ];
  dag_task_completed: [taskId: string, result: unknown];
  task_created: [taskId: string, task: unknown];
  scene_recognized: [scene: string, confidence: number];
}

export interface WebSocketEvents {
  ws_send: [data: unknown];
  ws_receive: [data: unknown];
}

export interface AgentExecutionEvents {
  agent_execution_update: [
    payload: {
      traceId: string;
      phase: string;
      status: string;
      result?: unknown;
      timestamp: string;
      roundsUsed?: number;
      toolCallsUsed?: number;
      toolCallsCount?: number;
      elapsedMs?: number;
      message?: string;
      attempt?: number;
      toolName?: string;
      toolSuccess?: boolean;
      duration?: number;
    },
  ];
  perception_update: [
    payload: {
      traceId: string;
      modality: 'voice' | 'image' | 'text' | 'sensor' | 'fusion';
      status: 'started' | 'processing' | 'completed' | 'failed';
      progress?: number;
      result?: unknown;
      confidence?: number;
      error?: string;
      timestamp: string;
    },
  ];
  brain_stage_update: [
    payload: {
      traceId: string;
      stage:
        | 'intent_recognition'
        | 'task_decomposition'
        | 'scene_recognition'
        | 'memory_retrieval'
        | 'llm_generation'
        | 'persona_adjustment'
        | 'function_calling';
      status: 'started' | 'completed' | 'failed';
      duration?: number;
      result?: unknown;
      timestamp: string;
    },
  ];
  skill_execution_update: [
    payload: {
      traceId: string;
      skillName: string;
      step: 'started' | 'retry' | 'fallback' | 'completed' | 'failed';
      attempt?: number;
      maxRetries?: number;
      duration?: number;
      error?: string;
      timestamp: string;
    },
  ];
  tool_trace: [
    payload: {
      timestamp: string;
      traceId: string;
      toolCallId: string;
      toolName: string;
      status: 'started' | 'completed' | 'failed';
      duration: number;
      success: boolean | null;
      errorMessage: string | null;
    },
  ];
}

export interface VibeCodingEvents {
  clarification_request: [
    payload: {
      traceId: string;
      question: string;
      options?: string[];
      context?: string;
      timestamp: string;
    },
  ];
  clarification_response: [
    payload: { traceId: string; response: string; timestamp: string },
  ];
  execution_preview: [
    payload: {
      traceId: string;
      summary: string;
      changes: Array<{
        type: 'file' | 'command' | 'api';
        target: string;
        action: string;
        risk: 'none' | 'low' | 'medium' | 'high' | 'critical';
        preview?: string;
      }>;
      estimatedTime?: number;
      timestamp: string;
    },
  ];
  execution_confirm: [
    payload: { traceId: string; confirmed: boolean; timestamp: string },
  ];
  file_modified: [
    payload: {
      traceId: string;
      filePath: string;
      changeType: 'created' | 'modified' | 'deleted';
      timestamp: string;
    },
  ];
  file_rollback: [
    payload: {
      traceId: string;
      filePath: string;
      success: boolean;
      timestamp: string;
    },
  ];
  multi_file_modified: [
    payload: {
      traceId: string;
      files: Array<{
        path: string;
        changeType: 'created' | 'modified' | 'deleted';
      }>;
      timestamp: string;
    },
  ];
  budget_exceeded: [
    payload: {
      tokensUsed: number;
      roundsUsed: number;
      toolCallsUsed: number;
      elapsed: number;
      timestamp: string;
    },
  ];
  write_approval_request: [
    payload: {
      operation: string;
      target: string;
      changes: string;
      riskReason?: string;
      timestamp: string;
    },
  ];
}

export interface AutomationEvents {
  automation_task_toggle: [
    payload: { taskId: string; enabled: boolean; timestamp: string },
  ];
  automation_task_create: [
    payload: { task: Record<string, unknown>; timestamp: string },
  ];
  automation_trigger_execute: [
    payload: { trigger: Record<string, unknown>; timestamp: string },
  ];
  automation_task_update: [
    payload: {
      taskId: string;
      name: string;
      enabled: boolean;
      executionCount: number;
      successCount: number;
      lastRun?: string;
      timestamp: string;
    },
  ];
  automation_trigger_fired: [
    payload: {
      type: 'schedule' | 'emotion' | 'behavior' | 'pattern' | 'time' | 'memory';
      reason: string;
      priority: number;
      suggestedAction?: string;
      context?: Record<string, unknown>;
      timestamp: string;
    },
  ];
  automation_pattern_update: [
    payload: {
      activeHours: number[];
      frequentTopics: string[];
      taskCompletionRate: number;
      lastActiveTime: number;
      averageSessionDuration: number;
      preferredCommunicationStyle: string;
      timestamp: string;
    },
  ];
  automation_proactive_message: [
    payload: {
      message: string;
      triggerType: string;
      context?: Record<string, unknown>;
      timestamp: string;
    },
  ];
}

export interface IntegrationEvents {
  integration_connected: [payload: { platform: string; timestamp: string }];
  integration_disconnected: [payload: { platform: string; timestamp: string }];
  integration_message: [
    payload: {
      platform: string;
      type: string;
      content: string;
      from?: string;
      fromName?: string;
      timestamp: string;
      rawData?: unknown;
    },
  ];
}

export interface TraceEvents {
  event_traced: [
    payload: {
      eventName: string;
      traceId: string;
      duration: number;
      success: boolean;
      timestamp: string;
      metadata?: Record<string, unknown>;
    },
  ];
  trace_started: [
    payload: { traceId: string; eventName: string; timestamp: string },
  ];
  trace_completed: [
    payload: {
      traceId: string;
      eventName: string;
      duration: number;
      success: boolean;
    },
  ];
  trace_error: [
    payload: {
      traceId: string;
      eventName: string;
      error: string;
      duration: number;
    },
  ];
}

export interface CLIWSEvents {
  ws_connected: [payload: { url: string }];
  ws_disconnected: [payload: Record<string, unknown>];
  tool_start: [
    payload: {
      toolName: string;
      toolId: string;
      input?: Record<string, unknown>;
      timestamp: number;
    },
  ];
  tool_complete: [
    payload: {
      toolName: string;
      toolId: string;
      output?: unknown;
      duration: number;
      timestamp: number;
    },
  ];
  tool_error: [
    payload: {
      toolName: string;
      toolId: string;
      error: string;
      timestamp: number;
    },
  ];
  agent_plan: [
    payload: {
      planId: string;
      steps: Array<{ description: string; tool?: string }>;
      timestamp: number;
    },
  ];
  agent_execute: [
    payload: {
      planId: string;
      stepIndex: number;
      status: 'running' | 'completed' | 'failed';
      timestamp: number;
    },
  ];
  agent_evaluate: [
    payload: {
      planId: string;
      qualityScore: number;
      feedback?: string;
      timestamp: number;
    },
  ];
  evolution_cycle: [
    payload: {
      cycleId: string;
      reason: string;
      adjustments: Array<{ type: string; target: string; change: string }>;
      timestamp: number;
    },
  ];
}

export interface SecurityEvents {
  approval_request: [
    payload: {
      id: string;
      type: string;
      description: string;
      target: string;
      risk: string;
      approved?: boolean;
      method?: string;
    },
  ];
}

export interface ImplicitFeedbackEvents {
  'user:message': [payload: { content: string; timestamp: number }];
  'ai:message': [payload: { content: string; timestamp: number }];
  'user:copy': [payload: { content: string; timestamp: number }];
  'user:modify': [
    payload: { original: string; modified: string; timestamp: number },
  ];
  'user:delete': [payload: { content: string; timestamp: number }];
  'feedback:implicit': [payload: FeedbackSignal];
}

export interface SessionEvents {
  session_reset: [payload: { reason?: string; timestamp: string }];
  gateway_input_received: [
    payload: {
      traceId: string;
      source: string;
      textLength: number;
      executionDepth: number;
    },
  ];
  gateway_output_sent: [
    payload: {
      traceId: string;
      response: string;
      duration?: number;
      success?: boolean;
    },
  ];
  event_store_appended: [
    payload: {
      eventId: string;
      sessionId: string;
      eventType: string;
      sequenceNum: number;
    },
  ];
  event_store_snapshot_saved: [
    payload: {
      sessionId: string;
      sequenceNum: number;
      eventCount: number;
    },
  ];
  session_replay_started: [
    payload: {
      sessionId: string;
      fromSequence?: number;
      toSequence?: number;
    },
  ];
  session_replay_completed: [
    payload: {
      sessionId: string;
      replayedEvents: number;
      duration: number;
    },
  ];
}

export interface CommandEvents {
  retry_requested: [payload: { traceId?: string; reason?: string }];
  undo_requested: [payload: { traceId?: string; step?: string }];
  agent_stop_requested: [payload: { traceId?: string; reason?: string }];
  compress_requested: [payload: { sessionId?: string }];
  session_title_set: [payload: { title: string; sessionId?: string }];
  cron_list_requested: [payload: { userId?: string }];
  cron_run_requested: [payload: { taskId: string; userId?: string }];
  cron_pause_requested: [payload: { taskId: string; userId?: string }];
}

export interface BridgeEvents {
  'bridge:fallback': [
    payload: {
      from: 'ws' | 'http';
      to: 'ws' | 'http' | 'none';
      phase: string;
      error: string;
      pythonHealthy: boolean;
      timestamp: number;
    },
  ];
  'bridge:unavailable': [
    payload: {
      phase: string;
      error: string;
      timestamp: number;
    },
  ];
}

export interface EventMap
  extends
    CoreEvents,
    SchedulerEvents,
    ProactiveEvents,
    MemoryEvents,
    EvolutionEvents,
    OptimizationEvents,
    ResourceEvents,
    UserEvents,
    WebSocketEvents,
    AgentExecutionEvents,
    VibeCodingEvents,
    AutomationEvents,
    IntegrationEvents,
    TraceEvents,
    FileWatchEvents,
    CLIWSEvents,
    SecurityEvents,
    ImplicitFeedbackEvents,
    SessionEvents,
    CommandEvents,
    BridgeEvents {}
