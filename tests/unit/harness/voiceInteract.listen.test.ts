/**
 * voice_interact.listen / speak 测试（审计 P1-3，真实听觉）
 *
 * 验证：listen 经真实 ASR（SpeechRecognizer）识别 audioPath 音频并写入感知总线，
 * 无音频源时 fail-closed（不再静默 mock）；speak 经 TTS 后端切换（real 无真实合成器时显式报错）。
 * 本文件为 jest 冒烟测试，真实 jest 环境下运行；本机 node_modules 损坏时由
 * .p1verify/voice_listen.cjs（tsc 转译真实源码 + Module._load 桩）做等价运行时验证。
 */

import { createVoiceInteractExecutor } from '../../../harness/tools/system/voice_interact';
import { EventBus } from '../../../shared/EventBus';

jest.mock('fs', () => ({
  readFileSync: () => Buffer.from('RIFF....wav-bytes'),
  writeFileSync: () => {},
  existsSync: () => true,
  unlinkSync: () => {},
  mkdirSync: () => {},
}));

jest.mock('../../../multimodal/SpeechRecognizer', () => {
  return {
    SpeechRecognizer: class {
      async initialize() {}
      async recognize() {
        return { text: '你好世界', confidence: 0.92, language: 'zh-CN' };
      }
    },
  };
});

describe('voice_interact (P1-3 真实听觉)', () => {
  beforeEach(() => {
    (EventBus as unknown as { emit: jest.Mock }).emit = jest.fn();
  });

  it('listen(audioPath) 执行真实 ASR 并写入感知总线', async () => {
    const exec = createVoiceInteractExecutor({});
    const r = await exec({ action: 'listen', audioPath: 'clip.wav' }, {});
    expect(r.success).toBe(true);
    expect(r.metadata?.asr).toBe(true);
    expect(r.metadata?.text).toBe('你好世界');
    expect(EventBus.emit).toHaveBeenCalledWith(
      'voice_recognized',
      expect.objectContaining({ text: '你好世界' })
    );
  });

  it('listen 无音频源时 fail-closed', async () => {
    const exec = createVoiceInteractExecutor({});
    const r = await exec({ action: 'listen' }, {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/未提供音频源/);
  });

  it('speak(real) 无真实后端时显式报错', async () => {
    const exec = createVoiceInteractExecutor({});
    const r = await exec({ action: 'speak', text: '你好', ttsBackend: 'real' }, {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/未配置真实 TTS 后端/);
  });

  it('speak(mock) 走 mock 后端', async () => {
    const exec = createVoiceInteractExecutor({});
    const r = await exec({ action: 'speak', text: '你好', ttsBackend: 'mock' }, {});
    expect(r.success).toBe(true);
    expect(r.metadata?.backend).toBe('mock');
  });
});
