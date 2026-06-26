/**
 * 测试辅助：LoopContext 工厂
 *
 * 提供 createMockLoopContext 工厂函数，集中管理 LoopContext 的默认字段，
 * 避免 7+ 个测试文件中重复构造且在类型变更时需要逐个修改。
 */

import type { ChatMessage, LoopContext } from '../../../src/harness/types';
import { LoopState } from '../../../src/harness/types';

/**
 * 默认预算状态
 */
export const DEFAULT_BUDGET = {
  roundsUsed: 0,
  softRoundLimit: 4,
  hardRoundLimit: 8,
  tokensUsed: 0,
  tokenWarningLimit: 4500,
  tokenHardLimit: 6000,
  startTime: 0,
  maxDurationMs: 60000,
  toolCallsUsed: 0,
  maxToolCalls: 20,
};

/**
 * 默认 trace
 */
export const DEFAULT_TRACE = {
  traceId: 'test',
  state: LoopState.PLANNING,
  stateTransitions: [],
  trajectory: [],
  totalDuration: 0,
  totalToolCalls: 0,
  budgetState: { ...DEFAULT_BUDGET },
};

/**
 * 创建模拟 LoopContext
 *
 * @param overrides - 覆盖默认值的字段
 * @returns 完整的 LoopContext 对象（包含所有必需字段）
 */
export function createMockLoopContext(
  overrides: Partial<LoopContext> = {}
): LoopContext {
  return {
    messages: [],
    plan: null,
    currentStepIndex: 0,
    stepResults: new Map(),
    // P0 修复：补充 LoopContext 新增的必需字段
    stepOutputs: new Map(),
    dataFlowChannels: [],
    crossStepState: new Map(),
    stepStates: new Map(),
    stepStateHistory: [],
    budget: { ...DEFAULT_BUDGET },
    trace: { ...DEFAULT_TRACE },
    metadata: {},
    ...overrides,
  };
}

/**
 * 创建带消息的 LoopContext
 */
export function createLoopContextWithMessages(
  messages: ChatMessage[],
  overrides: Partial<LoopContext> = {}
): LoopContext {
  return createMockLoopContext({ messages, ...overrides });
}
