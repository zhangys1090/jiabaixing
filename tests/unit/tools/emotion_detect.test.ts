import { createEmotionDetectExecutor, EMOTION_DETECT_DEF } from '../../../src/harness/tools/cognition/emotion_detect';
import type { EmotionDetectDeps } from '../../../src/harness/tools/cognition/emotion_detect';

describe('emotion_detect executor', () => {
  it('缺依赖时诚实失败而非崩溃/假成功', async () => {
    const exec = createEmotionDetectExecutor({} as unknown as EmotionDetectDeps);
    const r = await exec({ text: '我好生气' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未注入');
  });

  it('依赖注入后返回规则情绪结果', async () => {
    const exec = createEmotionDetectExecutor({
      detectEmotionFromInput: () => ({ type: 'angry', intensity: 0.8, confidence: 0.9 }),
    });
    const r = await exec({ text: '我好生气' });
    expect(r.success).toBe(true);
    const out = JSON.parse(r.output as string);
    expect(out.type).toBe('angry');
    expect(out.intensity).toBe(0.8);
  });

  it('依赖抛错时返回失败', async () => {
    const exec = createEmotionDetectExecutor({
      detectEmotionFromInput: () => {
        throw new Error('boom');
      },
    });
    const r = await exec({ text: 'x' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('boom');
  });

  it('DEF 标注轻量规则模式', () => {
    expect(EMOTION_DETECT_DEF.description).toContain('轻量规则模式');
  });
});
