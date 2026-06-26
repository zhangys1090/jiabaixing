/**
 * P5: 学习信号收集器 — 实时收集工具执行和任务完成的学习信号
 *
 * Hermes级别：每次执行都产生学习信号，而非仅依赖 user_correction 事件
 */
import { Logger } from '../utils/Logger';

export interface LearningSignal {
  signalType: 'positive' | 'negative' | 'task_success' | 'task_failure';
  toolName?: string;
  error?: string;
  quality?: number;
  duration?: number;
  userInput?: string;
  toolCount?: number;
  timestamp: number;
}

/** 原始学习信号输入类型 */
export type RawLearningSignal = {
  type: 'tool_success' | 'tool_failure' | 'task_complete' | 'task_failure';
  toolName?: string;
  error?: string;
  quality?: number;
  duration?: number;
  userInput?: string;
  toolCount?: number;
};

/** EventBus 最小契约 */
export interface LearningEventBus {
  emit(event: string, payload: unknown): void;
}

/**
 * 收集学习信号并通过 EventBus 广播
 *
 * @param eventBus - 事件总线，用于广播 learning_signal 事件
 * @param rawSignal - 原始学习信号
 */
export function collectLearningSignal(
  eventBus: LearningEventBus,
  rawSignal: RawLearningSignal
): void {
  let signalType: LearningSignal['signalType'];

  switch (rawSignal.type) {
    case 'tool_success':
      signalType = 'positive';
      break;
    case 'tool_failure':
      signalType = 'negative';
      break;
    case 'task_complete':
      signalType = 'task_success';
      break;
    case 'task_failure':
      signalType = 'task_failure';
      break;
  }

  const signal: LearningSignal = {
    signalType,
    toolName: rawSignal.toolName,
    error: rawSignal.error,
    quality: rawSignal.quality,
    duration: rawSignal.duration,
    userInput: rawSignal.userInput,
    toolCount: rawSignal.toolCount,
    timestamp: Date.now(),
  };

  eventBus.emit('learning_signal', signal);
  Logger.debug(
    `📡 学习信号已收集: ${signalType} ${rawSignal.toolName || ''}`,
    'LearningSignalCollector'
  );
}
