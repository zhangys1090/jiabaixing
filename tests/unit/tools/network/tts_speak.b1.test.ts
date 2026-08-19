import { createTTSSpeakExecutor } from '../../../../src/harness/tools/network/tts_speak';

describe('tts_speak 诚实失败 (C1)', () => {
  it('无合成器 → success:false', async () => {
    const r = await createTTSSpeakExecutor({})({ text: 'hi' });
    expect(r.success).toBe(false);
  });

  it('合成器抛错 → success:false', async () => {
    const r = await createTTSSpeakExecutor({
      speechSynthesizer: {
        speak: async () => {
          throw new Error('boom');
        },
      } as any,
    })({ text: 'hi' });
    expect(r.success).toBe(false);
  });

  it('合成器显式失败 → success:false', async () => {
    const r = await createTTSSpeakExecutor({
      speechSynthesizer: {
        speak: async () => ({ success: false, error: 'nope' }),
      } as any,
    })({ text: 'hi' });
    expect(r.success).toBe(false);
  });

  it('合成成功 → success:true', async () => {
    const r = await createTTSSpeakExecutor({
      speechSynthesizer: {
        speak: async () => ({ success: true, duration: 50 }),
      } as any,
    })({ text: 'hi' });
    expect(r.success).toBe(true);
  });

  it('空文本 → success:false', async () => {
    const r = await createTTSSpeakExecutor({
      speechSynthesizer: { speak: async () => ({ success: true }) } as any,
    })({ text: '' });
    expect(r.success).toBe(false);
  });
});
