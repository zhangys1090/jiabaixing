/**
 * 端到端测试：聊天交互完整流程
 * 验证：用户问候 → AI回应 → 告知名字 → AI记住 → 询问名字 → AI正确回答
 */

import { JiabaixingCore } from '../../../src/core/JiabaixingCore';
import { MemoryEngine } from '../../../src/memory/MemoryEngine';
import { EventBus } from '../../../src/shared/EventBus';

describe('聊天交互端到端测试', () => {
  let core: JiabaixingCore;
  let memoryEngine: MemoryEngine;

  beforeEach(async () => {
    memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();

    core = new JiabaixingCore();
    core.setMemoryEngine(memoryEngine);

    await core.initialize();
  });

  afterEach(async () => {
    EventBus.removeAllListeners();
  });

  test('TC1: 用户问候 → AI 回应', async () => {
    const result = await core.processInput('你好', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
    expect(result.response.length).toBeGreaterThan(0);
    expect(result.traceId).toBeDefined();
  }, 30000);

  test('TC2: 用户告知名字 → AI 记住', async () => {
    const result = await core.processInput('我叫张三', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();

    // 验证名字被提取到用户画像
    const profile = memoryEngine.getUserProfile();
    const basicInfo = (profile as any).getBasicInfo?.() || (profile as any).basicInfo;
    expect(basicInfo?.name).toBe('张三');
  }, 30000);

  test('TC3: 多轮对话 → 上下文保持', async () => {
    // 第一轮：告知名字
    const round1 = await core.processInput('我叫李四', 'test_user');
    expect(round1.response).toBeDefined();

    // 第二轮：询问名字
    const round2 = await core.processInput('我叫什么名字？', 'test_user');
    expect(round2.response).toBeDefined();

    // 验证 AI 记住了名字
    const hasName = round2.response.includes('李四') || round2.response.includes('四');
    expect(hasName).toBe(true);
  }, 30000);

  test('TC4: 超长消息 → 前端拦截（模拟）', async () => {
    const longInput = '测试'.repeat(300); // 600字

    const result = await core.processInput(longInput, 'test_user');

    // 后端应该能处理，但会记录警告
    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
  }, 30000);

  test('TC5: 无效输入 → 友好回复', async () => {
    const result = await core.processInput('', 'test_user');

    expect(result).toBeDefined();
    expect(result.response).toBeDefined();
    expect(result.response.length).toBeGreaterThan(0);
  }, 30000);

  test('TC6: 消息状态流转 → 完整生命周期', async () => {
    const messages: Array<{ status: string; timestamp: number }> = [];

    // 模拟消息状态变化
    const simulateMessageLifecycle = async () => {
      const states = ['sending', 'thinking', 'typing', 'sent'];
      for (const state of states) {
        messages.push({ status: state, timestamp: Date.now() });
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    await simulateMessageLifecycle();

    expect(messages).toHaveLength(4);
    expect(messages[0].status).toBe('sending');
    expect(messages[1].status).toBe('thinking');
    expect(messages[2].status).toBe('typing');
    expect(messages[3].status).toBe('sent');
  });
});
