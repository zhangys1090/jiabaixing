// 进化类型枚举
export enum EvolutionType {
  CODE_FIX = 'CODE_FIX',           // 代码修复
  CODE_OPTIMIZATION = 'CODE_OPTIMIZATION',  // 代码优化
  PROMPT_IMPROVEMENT = 'PROMPT_IMPROVEMENT',  // Prompt 优化
  TOOL_ENHANCEMENT = 'TOOL_ENHANCEMENT',  // 工具增强
  ARCHITECTURE_CHANGE = 'ARCHITECTURE_CHANGE',  // 架构调整
}

// 进化优先级
export enum EvolutionPriority {
  CRITICAL = 'CRITICAL',   // 紧急修复
  HIGH = 'HIGH',          // 高优先级
  MEDIUM = 'MEDIUM',      // 中优先级
  LOW = 'LOW',            // 低优先级
}

// 进化原因
export interface EvolutionCause {
  type: 'FAILURE' | 'LOW_SATISFACTION' | 'BUG_REPORT' | 'PROACTIVE_IMPROVEMENT' | 'PERFORMANCE_ISSUE';
  description: string;
  context: {
    failureInfo?: string;
    satisfactionScore?: number;
    performanceMetric?: { name: string; value: number; threshold: number };
  };
  timestamp: number;
}

// 代码修改位置
export interface CodeLocation {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  snippet?: string;
}

// 单个进化操作
export interface EvolutionAction {
  type: 'MODIFY_FILE' | 'CREATE_FILE' | 'DELETE_FILE' | 'UPDATE_PROMPT' | 'UPDATE_CONFIG';
  target: CodeLocation | string;  // 位置或目标
  content: string;  // 新内容
  originalContent?: string;  // 原内容（用于回滚）
  description: string;
}

// 完整进化方案
export interface EvolutionPlan {
  id: string;
  type: EvolutionType;
  priority: EvolutionPriority;
  cause: EvolutionCause;
  title: string;
  description: string;
  actions: EvolutionAction[];
  estimatedRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  validationSteps: string[];
  rollbackPlan?: { checkpointId: string; actions: EvolutionAction[] };
  createdAt: number;
}

// 执行结果
export interface EvolutionResult {
  planId: string;
  success: boolean;
  executedActions: number;
  failedAt?: number;
  error?: string;
  validationResult?: { passed: boolean; details: string };
  duration: number;
  rollbackNeeded?: boolean;
  rollbackResult?: { success: boolean; error?: string };
}

// 回滚点
export interface RollbackCheckpoint {
  id: string;
  planId: string;
  timestamp: number;
  snapshot: Record<string, string>;  // key: file path, value: original content
  gitCommitHash?: string;
}

// 进化历史记录
export interface EvolutionHistory {
  planId: string;
  type: EvolutionType;
  title: string;
  success: boolean;
  cause: EvolutionCause;
  result: EvolutionResult;
  timestamp: number;
}

export interface EvolutionMetrics {
  totalEvolutions: number;
  successRate: number;
  averageDuration: number;
  evolutionsByType: Partial<Record<EvolutionType, number>>;
  rollbackRate: number;
  qualityImprovement: number;
}
