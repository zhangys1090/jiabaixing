/**
 * 记忆引擎接口（避免循环依赖）
 * 从 JiabaixingCore.ts 提取，供全系统统一引用
 */

import type {
  EpisodicMemory,
  RetrievalResult,
  RetrieveOptions,
  StoreOptions,
} from '../memory/EpisodicMemoryStore';

export interface IMemoryEngine {
  storeShortTermMemory?(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<unknown>;
  storeLongTermMemory?(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<unknown>;
  retrieveContext?(
    input: string,
    userId?: string
  ): Promise<{
    memories: Array<{ type: string; relevance: number; content: string }>;
    preferences: { codingStyle: string[]; namingRules: string[] };
  }>;
  storeFeedbackSignal?(data: {
    traceId?: string;
    toolName?: string;
    feedbackType: string;
    rating?: number;
    message?: string;
    userId?: string;
    timestamp?: number;
  }): Promise<void>;
  storeInstantMemory?(
    content: string | Record<string, unknown> | unknown[],
    scene?: string,
    emotion?: string
  ): Promise<unknown>;
  retrieveRelevant?(params: {
    query: string;
    limit?: number;
    includeBehaviorPatterns?: boolean;
  }): Promise<unknown[]>;
  /** 精确混合检索 — 支持场景/情绪过滤的语义检索 */
  preciseHybridRetrieval?(
    query: string,
    scene?: string,
    emotion?: string,
    topK?: number
  ): Promise<unknown[]>;
  getUserProfileSummary?(userId: string): Promise<{
    name?: string;
    preferredLanguage?: string;
    preferredFrameworks?: string[];
    recentTopics?: string[];
  }>;
  getUserProfile?():
    | import('./ConstitutionPromptBuilder').MemoryEngineUserProfile
    | null;
  detectBehaviorPatterns?(): unknown[];
  /** 标记用户活跃（用于记忆"做梦"机制判断空闲状态） */
  markUserActive?(): void;
  getPersistentMemory?(): import('../memory/PersistentMemoryService').PersistentMemoryService;

  /** P1-2: 情景记忆存储 — 从 Python 迁移 EpisodicMemoryStore */
  storeEpisodicMemory?(
    content: string,
    options?: StoreOptions
  ): Promise<EpisodicMemory>;
  /** P1-2: 情景记忆检索 */
  retrieveEpisodicMemory?(options?: RetrieveOptions): RetrievalResult;
  /** P1-2: 获取情景记忆统计 */
  getEpisodicMemoryStats?(): Record<string, unknown>;
}
