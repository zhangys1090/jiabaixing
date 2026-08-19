/**
 * Python 桥接实例注册表
 *
 * 单一轻量模块，持有当前激活的 PythonAgentBridge 实例。
 * 由 bootstrap.ts 在创建/销毁 pythonBridge 时登记，供非路由层调用方
 * （shutdown / MCPToolBridge / MultiPlatformGateway / TRAEOptimizationIntegrator）
 * 统一获取，避免重蹈从 bootstrap 引入造成的循环依赖。
 */

import type { PythonAgentBridge } from './PythonAgentBridge';

let activeBridge: PythonAgentBridge | null = null;

/** 登记当前激活的 Python 桥接实例（bootstrap 在创建/置空时调用） */
export function setActivePythonBridge(bridge: PythonAgentBridge | null): void {
  activeBridge = bridge;
}

/** 获取当前激活的 Python 桥接实例；未连接（AGENT_BACKEND=local 降级）时返回 null */
export function getActivePythonBridge(): PythonAgentBridge | null {
  return activeBridge;
}
