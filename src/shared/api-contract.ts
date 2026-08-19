export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
  tsImplemented: boolean;
  pyImplemented: boolean;
  requestSchema?: string;
  responseSchema?: string;
}

export const API_CONTRACT: ApiEndpoint[] = [
  { method: 'GET', path: '/api/health', description: '健康检查', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/models', description: '模型列表', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/models/status', description: '模型状态', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/models/health', description: '模型健康', tsImplemented: true, pyImplemented: false },
  { method: 'POST', path: '/api/chat', description: '聊天请求', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/correct', description: '纠错请求', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/tools/list', description: '工具列表', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/skills/list', description: '技能列表', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/skills/execute', description: '技能执行', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/system/resources', description: '系统资源', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/memory/stats', description: '记忆统计', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/search', description: '记忆搜索', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/store', description: '记忆存储', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/metrics', description: '性能指标', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/config', description: '配置查询', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/evolution/status', description: '进化状态', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/conversations', description: '会话列表', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/trajectory/export', description: '轨迹导出', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/trajectory/stats', description: '轨迹统计', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/security/logs', description: '安全日志', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/security/events', description: '安全事件', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/security/audit', description: '安全审计', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/performance/snapshot', description: '性能快照', tsImplemented: true, pyImplemented: false },
  { method: 'GET', path: '/api/mcp/servers', description: 'MCP 服务器列表', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/mcp/servers/{name}/start', description: '启动 MCP 服务器', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/mcp/servers/{name}/stop', description: '停止 MCP 服务器', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/mcp/servers/{name}/tools', description: 'MCP 工具列表', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/mcp/servers/{name}/message', description: 'MCP 消息', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/sessions', description: '创建会话', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/sessions/{id}', description: '获取会话', tsImplemented: true, pyImplemented: true },
  { method: 'DELETE', path: '/api/sessions/{id}', description: '删除会话', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/sessions/{id}/checkpoint', description: '创建检查点', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/sessions/{id}/resume', description: '恢复会话', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/plan', description: '任务规划', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/plan/execute', description: '执行计划', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/plan/evaluate', description: '评估计划', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/plan/reflect', description: '反思计划', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/store-short-term', description: '短期记忆', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/store-long-term', description: '长期记忆', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/store-episodic', description: '情节记忆', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/hybrid-retrieval', description: '混合检索', tsImplemented: true, pyImplemented: true },
  { method: 'POST', path: '/api/memory/dream', description: '记忆整理', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/memory/knowledge-graph', description: '知识图谱', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/health/slo', description: 'SLO 健康', tsImplemented: true, pyImplemented: true },
  { method: 'GET', path: '/api/security/apikeys', description: 'API Key 列表', tsImplemented: true, pyImplemented: false },
  { method: 'POST', path: '/api/security/apikeys/rotate', description: 'API Key 轮换', tsImplemented: true, pyImplemented: false },
  { method: 'POST', path: '/api/security/apikeys/revoke', description: 'API Key 撤销', tsImplemented: true, pyImplemented: false },
];

export function getContractGaps(): { tsOnly: ApiEndpoint[]; pyOnly: ApiEndpoint[]; both: ApiEndpoint[] } {
  const tsOnly = API_CONTRACT.filter(e => e.tsImplemented && !e.pyImplemented);
  const pyOnly = API_CONTRACT.filter(e => e.pyImplemented && !e.tsImplemented);
  const both = API_CONTRACT.filter(e => e.tsImplemented && e.pyImplemented);
  return { tsOnly, pyOnly, both };
}

export function getContractStats(): { total: number; tsOnly: number; pyOnly: number; aligned: number; alignmentRate: string } {
  const gaps = getContractGaps();
  const aligned = gaps.both.length;
  const total = API_CONTRACT.length;
  return {
    total,
    tsOnly: gaps.tsOnly.length,
    pyOnly: gaps.pyOnly.length,
    aligned,
    alignmentRate: `${((aligned / total) * 100).toFixed(1)}%`,
  };
}
