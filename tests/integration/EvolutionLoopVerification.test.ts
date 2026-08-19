/**
 * 进化闭环验证（TS 侧）—— 验证 Loop B 已迁移到 Python 后端桥接
 *
 * 原 V1 EvolutionEngine（TS 独立实现）已删除并按 AGENTS.md §0.1 迁移到 Python。
 * TS 薄网关仅通过 PythonAgentBridge 转发：
 *   1. 用户交互反馈 → bridge.submitFeedback() → /v1/evolution/feedback
 *   2. 进化指标     → bridge.getEvolutionMetrics() → /v1/evolution/metrics
 *   3. 进化洞察     → bridge.getInsights() → /v1/evolution/insights
 *   4. 手动触发     → bridge.triggerEvolution() → /v1/evolution/trigger
 *   5. 权重同步     → initEvolution 的 syncEvolutionWeights 经 bridge 获取权重
 *
 * 端到端行为由 python/agent 的 pytest（api/evolution + engine）覆盖；
 * 本测试仅校验 TS 侧的桥接契约（方法存在且路由已装配），无需启动 Python。
 */

import { PythonAgentBridge } from '../../src/ide/PythonAgentBridge';
import { registerEvolutionRoutes } from '../../src/server/routes/evolutionRoutes';

describe('进化闭环（Python 桥接）验证', () => {
  it('PythonAgentBridge 暴露全部进化转发方法', () => {
    const proto = PythonAgentBridge.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(typeof proto.getInsights).toBe('function');
    expect(typeof proto.getEvolutionMetrics).toBe('function');
    expect(typeof proto.triggerEvolution).toBe('function');
    expect(typeof proto.submitFeedback).toBe('function');
  });

  it('evolutionRoutes 模块可导出 registerEvolutionRoutes', () => {
    expect(typeof registerEvolutionRoutes).toBe('function');
  });
});
