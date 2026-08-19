/**
 * MemoryEngineBridge — 记忆引擎 TS↔Python 桥接实现
 *
 * 依据 AGENTS.md §0.1：记忆系统（短期/长期）核心逻辑必须以 Python 端为主实现。
 * 本类不实现任何记忆核心逻辑，仅作为 TS 侧桥接契约（实现 IMemoryEngine），
 * 将每个方法经 bridgeRegistry 代理到 Python FastAPI(:3112) 的 /v1/memory/* 端点。
 *
 * AGENT_BACKEND=python（默认）时全部走 Python；Python 不可用时按最小可用降级。
 */

import { getActivePythonBridge } from '../ide/bridgeRegistry';
import Logger from '../utils/Logger';
import { UserProfile } from './UserProfile';
import type { IMemoryEngine } from '../core/IMemoryEngine';
import type { MemoryEngineUserProfile } from '../core/ConstitutionPromptBuilder';

// 复用既有类型/枚举，保持下游 import 不变
export enum MemoryType {
  INSTANT = 'instant',
  SHORT_TERM = 'short_term',
  LONG_TERM = 'long_term',
}
export enum MemoryTier {
  HOT = 'hot',
  WARM = 'warm',
  COLD = 'cold',
}
export type MemoryContent = string | Record<string, unknown> | unknown[];
export interface MemoryItem {
  id: string;
  type: MemoryType;
  content: MemoryContent;
  timestamp: Date;
  scene?: string;
  emotion?: string;
  relevanceScore?: number;
  keywordScore?: number;
  vectorScore?: number;
  accessCount?: number;
  lastAccessTime?: number;
  decayScore?: number;
  importance?: number;
  category?: string;
  isCompressed?: boolean;
  mergedFrom?: string[];
}
export interface TrackedResult {
  success: boolean;
  traceId: string;
  duration: number;
  data?: MemoryItem | MemoryItem[];
  error?: string;
}
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
export interface GraphNode {
  id: string;
  label: string;
  type: 'entity' | 'concept' | 'event';
  weight?: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  weight?: number;
}
export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Python 端混合检索返回的扁平条目结构 */
interface MemoryRetrievalRow {
  id: string;
  type: string;
  content: string;
  timestamp: number;
  scene: string;
  emotion: string;
  relevanceScore: number;
}

/**
 * 记忆引擎桥接实现。所有方法委托 Python；本地仅做最小降级（返回空结果 / no-op），不实现核心逻辑。
 */
export class MemoryEngineBridge implements IMemoryEngine {
  /** 本地用户画像存根（Python 持有真实数据；生产仅经 getUserProfile 暴露本地视图，与旧 MemoryEngine 行为一致） */
  private userProfile = new UserProfile();

  // ==================== 存储 ====================

  public async storeShortTermMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    const bridge = getActivePythonBridge();
    const contentStr =
      typeof content === 'string' ? content : JSON.stringify(content);
    if (bridge) {
      const id = await bridge.memoryStoreShortTerm(contentStr, scene, emotion);
      return {
        id,
        type: MemoryType.SHORT_TERM,
        content,
        timestamp: new Date(),
        scene,
        emotion,
      };
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，storeShortTermMemory 降级为空',
      'MemoryEngineBridge'
    );
    return {
      id: '',
      type: MemoryType.SHORT_TERM,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };
  }

  public async storeLongTermMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    const bridge = getActivePythonBridge();
    const contentStr =
      typeof content === 'string' ? content : JSON.stringify(content);
    if (bridge) {
      const id = await bridge.memoryStoreLongTerm(contentStr, scene, emotion);
      return {
        id,
        type: MemoryType.LONG_TERM,
        content,
        timestamp: new Date(),
        scene,
        emotion,
      };
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，storeLongTermMemory 降级为空',
      'MemoryEngineBridge'
    );
    return {
      id: '',
      type: MemoryType.LONG_TERM,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };
  }

  public async storeInstantMemory(
    content: MemoryContent,
    scene?: string,
    emotion?: string
  ): Promise<MemoryItem> {
    const bridge = getActivePythonBridge();
    const contentStr =
      typeof content === 'string' ? content : JSON.stringify(content);
    if (bridge) {
      const id = await bridge.memoryStoreInstant(contentStr, scene, emotion);
      return {
        id,
        type: MemoryType.INSTANT,
        content,
        timestamp: new Date(),
        scene,
        emotion,
      };
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，storeInstantMemory 降级为空',
      'MemoryEngineBridge'
    );
    return {
      id: '',
      type: MemoryType.INSTANT,
      content,
      timestamp: new Date(),
      scene,
      emotion,
    };
  }

  public async storeFeedbackSignal(data: {
    traceId?: string;
    toolName?: string;
    feedbackType: string;
    rating?: number;
    message?: string;
    userId?: string;
    timestamp?: number;
  }): Promise<void> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      // bridge.memoryStoreFeedback 要求 feedbackType 为字面量联合类型，调用处放宽后在此收窄
      await bridge.memoryStoreFeedback(
        data as Parameters<typeof bridge.memoryStoreFeedback>[0]
      );
      return;
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，storeFeedbackSignal 降级丢弃',
      'MemoryEngineBridge'
    );
  }

  // ==================== 检索 ====================

  public async preciseHybridRetrieval(
    query: string,
    scene?: string,
    emotion?: string,
    topK: number = 10
  ): Promise<MemoryItem[]> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      const results = await bridge.memoryHybridRetrieval(
        query,
        scene,
        emotion,
        topK
      );
      return results.map((r: MemoryRetrievalRow) => ({
        id: r.id,
        type: (r.type as MemoryType) || MemoryType.SHORT_TERM,
        content: r.content,
        timestamp: new Date(r.timestamp || Date.now()),
        scene: r.scene,
        emotion: r.emotion,
        relevanceScore: r.relevanceScore,
      }));
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，preciseHybridRetrieval 降级为空',
      'MemoryEngineBridge'
    );
    return [];
  }

  public async retrieveRelevant(params: {
    query: string;
    limit?: number;
    includeBehaviorPatterns?: boolean;
  }): Promise<unknown[]> {
    // retrieveRelevant 是 preciseHybridRetrieval 的薄包装
    return this.preciseHybridRetrieval(
      params.query,
      undefined,
      undefined,
      params.limit || 10
    );
  }

  public async retrieveContext(
    input: string,
    userId?: string
  ): Promise<{
    memories: Array<{ type: string; relevance: number; content: string }>;
    preferences: { codingStyle: string[]; namingRules: string[] };
  }> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      try {
        const results = await bridge.memoryRetrieveContext(input, userId);
        return {
          memories: results.map((r: MemoryRetrievalRow) => ({
            type: r.type || '记忆',
            relevance: r.relevanceScore || 0.5,
            content:
              typeof r.content === 'string'
                ? r.content
                : JSON.stringify(r.content),
          })),
          preferences: { codingStyle: [], namingRules: [] },
        };
      } catch {
        return {
          memories: [],
          preferences: { codingStyle: [], namingRules: [] },
        };
      }
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，retrieveContext 降级为空',
      'MemoryEngineBridge'
    );
    return {
      memories: [],
      preferences: { codingStyle: [], namingRules: [] },
    };
  }

  // ==================== 用户配置 ====================

  /**
   * 返回本地 UserProfile 存根（与旧 MemoryEngine.getUserProfile 行为一致：
   * 本地视图，真实数据由 Python 端持有）。供 UnifiedContextPipeline /
   * ConstitutionPromptBuilder 等同步调用 getBasicInfo()/getDevelopmentHabits() 等。
   */
  public getUserProfile(): MemoryEngineUserProfile | null {
    // 本地 UserProfile 实例在运行时具备 MemoryEngineUserProfile 要求的全部方法
    // (getBasicInfo/getDevelopmentHabits/getLifePreferences/.../syncProfileFromEvolution)，
    // 但 syncProfileFromEvolution 形参类型（具体对象 vs unknown）与目标接口不严格等价，故此处收窄转换。
    return this.userProfile as unknown as MemoryEngineUserProfile;
  }

  public async getUserProfileSummary(userId: string): Promise<{
    name?: string;
    preferredLanguage?: string;
    preferredFrameworks?: string[];
    recentTopics?: string[];
  }> {
    const basic = this.userProfile.getBasicInfo();
    const dev = this.userProfile.getDevelopmentHabits();
    return {
      name: basic.name || undefined,
      preferredLanguage: undefined,
      preferredFrameworks: dev.preferredFrameworks,
      recentTopics: [],
    };
  }

  // ==================== 反馈 / 更新 ====================

  public async queryRecentFeedback(hours: number = 24): Promise<unknown[]> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      return await bridge.memoryQueryRecentFeedback(hours);
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，queryRecentFeedback 降级为空',
      'MemoryEngineBridge'
    );
    return [];
  }

  public async updateMemory(
    memoryId: string,
    updates: {
      content?: string;
      scene?: string;
      emotion?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const bridge = getActivePythonBridge();
    if (bridge) {
      await bridge.memoryUpdate(memoryId, updates);
      return;
    }
    Logger.warn(
      '[MemoryEngineBridge] Python 不可用，updateMemory 降级丢弃',
      'MemoryEngineBridge'
    );
  }

  // ==================== 内部 / 可选方法 ====================

  /** 标记用户活跃（用于记忆"做梦"机制判断空闲状态）。Python 端自行管理活跃追踪，此处为 no-op。 */
  public markUserActive(): void {
    // Python 端 manage activity tracking; 本地无需实现核心逻辑
  }

  /** Python 记忆引擎在 FastAPI 启动时已初始化，此处无需本地初始化。 */
  public async initialize(): Promise<void> {
    return;
  }

  public isInitialized(): boolean {
    return getActivePythonBridge() !== null;
  }

  // IMemoryEngine 可选成员 — 最小可用降级（Python 侧经 store/search 已覆盖语义）
  public getEpisodicMemoryStats(): Record<string, unknown> {
    return {};
  }

  public detectBehaviorPatterns(): unknown[] {
    return [];
  }
}
