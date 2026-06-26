/**
 * RL 训练轨迹导出器
 *
 * 从 Agent 会话中生成轨迹数据，用于强化学习和模型微调
 * 支持 ShareGPT / JSONL / OpenAI Fine-tuning 格式导出
 * 设计参考: Hermes Agent RL 训练数据生成
 */

/** 导出格式 */
export enum ExportFormat {
  SHAREGPT = 'sharegpt',
  JSONL = 'jsonl',
  OPENAI_FINETUNE = 'openai_finetune',
}

/** 轨迹步骤 */
export interface TrajectoryStep {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
}

/** 轨迹数据 */
export interface TrajectoryData {
  id: string;
  steps: TrajectoryStep[];
  quality: number;
  metadata?: Record<string, unknown>;
}

/** 导出配置 */
export interface ExporterConfig {
  /** 最低质量分数 */
  minQuality?: number;
  /** 最高质量分数 */
  maxQuality?: number;
  /** 最大步骤数 */
  maxSteps?: number;
}

/** ShareGPT 对话格式 */
export interface ShareGPTConversation {
  conversations: Array<{ from: 'human' | 'gpt' | 'system'; value: string }>;
}

/** OpenAI Fine-tuning 格式 */
export interface OpenAIFineTuneMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI Fine-tuning 对话格式 */
export interface OpenAIFineTuneConversation {
  messages: OpenAIFineTuneMessage[];
}

export class TrajectoryExporter {
  private config: Required<ExporterConfig>;

  constructor(config?: ExporterConfig) {
    this.config = {
      minQuality: config?.minQuality ?? 0.0,
      maxQuality: config?.maxQuality ?? 1.0,
      maxSteps: config?.maxSteps ?? 100,
    };
  }

  /**
   * 按质量分数过滤轨迹
   */
  filterByQuality(trajectories: TrajectoryData[]): TrajectoryData[] {
    return trajectories.filter((t) => {
      return (
        t.quality >= this.config.minQuality &&
        t.quality <= this.config.maxQuality
      );
    });
  }

  /**
   * 导出为 ShareGPT 格式
   */
  toShareGPT(trajectories: TrajectoryData[]): ShareGPTConversation[] {
    const filtered = this.filterByQuality(trajectories);

    return filtered.map((t) => ({
      conversations: t.steps
        .filter(
          (s) =>
            s.role === 'user' || s.role === 'assistant' || s.role === 'system'
        )
        .map((s) => ({
          from:
            s.role === 'user'
              ? ('human' as const)
              : s.role === 'system'
                ? ('system' as const)
                : ('gpt' as const),
          value: s.content,
        })),
    }));
  }

  /**
   * 导出为 JSONL 格式
   */
  toJSONL(trajectories: TrajectoryData[]): string {
    const filtered = this.filterByQuality(trajectories);

    return filtered
      .map((t) =>
        JSON.stringify({
          id: t.id,
          quality: t.quality,
          steps: t.steps.map((s) => ({ role: s.role, content: s.content })),
        })
      )
      .join('\n');
  }

  /**
   * 导出为 OpenAI Fine-tuning 格式
   */
  toOpenAIFineTune(
    trajectories: TrajectoryData[]
  ): OpenAIFineTuneConversation[] {
    const filtered = this.filterByQuality(trajectories);

    return filtered.map((t) => ({
      messages: t.steps
        .filter(
          (s) =>
            s.role === 'system' || s.role === 'user' || s.role === 'assistant'
        )
        .map((s) => ({
          role: s.role as 'system' | 'user' | 'assistant',
          content: s.content,
        })),
    }));
  }

  /**
   * 通用导出方法
   */
  export(
    trajectories: TrajectoryData[],
    format: ExportFormat
  ): string | unknown[] {
    switch (format) {
      case ExportFormat.SHAREGPT:
        return this.toShareGPT(trajectories);
      case ExportFormat.JSONL:
        return this.toJSONL(trajectories);
      case ExportFormat.OPENAI_FINETUNE:
        return this.toOpenAIFineTune(trajectories);
      default:
        throw new Error(`不支持的导出格式: ${format}`);
    }
  }

  /**
   * 生成轨迹统计信息
   */
  getStats(trajectories: TrajectoryData[]): {
    total: number;
    filtered: number;
    avgQuality: number;
    avgSteps: number;
  } {
    const filtered = this.filterByQuality(trajectories);
    const avgQuality =
      filtered.length > 0
        ? filtered.reduce((sum, t) => sum + t.quality, 0) / filtered.length
        : 0;
    const avgSteps =
      filtered.length > 0
        ? filtered.reduce((sum, t) => sum + t.steps.length, 0) / filtered.length
        : 0;

    return {
      total: trajectories.length,
      filtered: filtered.length,
      avgQuality: Math.round(avgQuality * 100) / 100,
      avgSteps: Math.round(avgSteps * 10) / 10,
    };
  }
}
