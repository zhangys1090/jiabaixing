import { SubAgentFanout, PERCEPTION_AGENT_TEMPLATES } from './SubAgentFanout';
import { AgentRegistry } from './AgentRegistry';
import type { AgentRegistration } from './AgentRegistry';
import type { TaskNode } from './TaskDispatcher';

function makeRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  const reg = {
    id: 'a1',
    name: 'AgentA',
    capabilities: [{ name: 'c', description: 'd', tools: ['uia'], score: 90 }],
    status: 'idle' as const,
  } as unknown as AgentRegistration;
  registry.register(reg);
  return registry;
}

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 't1',
    name: 'T1',
    goal: 'do something',
    status: 'pending',
    priority: 'normal',
    agentType: 'worker',
    tools: ['uia'],
    dependencies: [],
    timeoutMs: 30000,
    metadata: {},
    ...overrides,
  } as unknown as TaskNode;
}

describe('SubAgentFanout W7/W8 traceId + 感知模板', () => {
  it('透传指定 traceId 到 FanoutResult 与每个 SubTaskResult', async () => {
    const fanout = new SubAgentFanout(makeRegistry());
    const result = await fanout.fanout('parent', [makeTask()], undefined, {
      traceId: 'trace-xyz',
    });
    expect(result.traceId).toBe('trace-xyz');
    expect(result.subResults).toHaveLength(1);
    expect(result.subResults[0].traceId).toBe('trace-xyz');
    expect(result.allSucceeded).toBe(true);
  });

  it('未指定 traceId 时自动生成非空 traceId', async () => {
    const fanout = new SubAgentFanout(makeRegistry());
    const result = await fanout.fanout('parent', [makeTask()]);
    expect(typeof result.traceId).toBe('string');
    expect(result.traceId.length).toBeGreaterThan(0);
    expect(result.subResults[0].traceId).toBe(result.traceId);
  });

  it('把 traceId 注入执行器收到的任务元数据', async () => {
    let received: TaskNode | null = null;
    const fanout = new SubAgentFanout(makeRegistry(), async (t) => {
      received = t;
      return { ok: true };
    });
    const result = await fanout.fanout('parent', [makeTask()], undefined, {
      traceId: 'trace-inject',
    });
    expect(received).not.toBeNull();
    expect((received as unknown as TaskNode).metadata?.traceId).toBe('trace-inject');
    expect(result.subResults[0].traceId).toBe('trace-inject');
  });

  it('感知模板类型注入到子任务元数据', async () => {
    const task = makeTask();
    const fanout = new SubAgentFanout(makeRegistry());
    await fanout.fanout('parent', [task], undefined, {
      traceId: 't1',
      perceptionTemplate: 'visual_operator',
    });
    expect(task.metadata?.perceptionTemplate).toBe('visual_operator');
  });

  it('预置感知型子 Agent 模板齐全', () => {
    expect(Object.keys(PERCEPTION_AGENT_TEMPLATES).sort()).toEqual([
      'desktop_automation',
      'device_control',
      'visual_operator',
    ]);
    expect(PERCEPTION_AGENT_TEMPLATES.visual_operator.modalities).toContain('visual');
    expect(PERCEPTION_AGENT_TEMPLATES.device_control.modalities).toContain('environment');
  });
});
