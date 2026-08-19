/**
 * SpeechRecognizer 安全单测 —— P0-1 ASR 命令注入防护
 *
 * 防护策略（双保险）：
 *  1) 调用方式改为 execFileSync + argv 数组（shell 默认关闭），绝不拼接 shell 字符串；
 *     即便模型名/路径含引号、分号、&& 等元字符，也只会被当作一个 argv 元素，
 *     不会被 shell 解释执行。
 *  2) validateWhisperInputs 白名单：模型名/语言/临时路径任一不合规即抛错，
 *     fail-closed 降级为空结果，子进程根本不会被调用。
 */

jest.mock('child_process', () => ({
  execFileSync: jest.fn(() => 'hello world'),
}));

import { execFileSync } from 'child_process';
import { SpeechRecognizer } from '../../../src/multimodal/SpeechRecognizer';

const mockExec = execFileSync as jest.Mock;

describe('SpeechRecognizer 安全：ASR 命令注入防护 (P0-1)', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockReturnValue('hello world');
  });

  function makeReady(model = 'base'): SpeechRecognizer {
    const r = new SpeechRecognizer({ model, language: 'zh-CN' });
    // 跳过真实 python 环境探测，直接置为可用状态
    (r as unknown as { initialized: boolean }).initialized = true;
    (r as unknown as { whisperModel: unknown }).whisperModel = {
      type: 'faster-whisper',
    };
    return r;
  }

  it('应使用 argv 数组而非 shell 字符串调用 python（杜绝拼接注入）', async () => {
    const r = makeReady();
    await r.recognize(Buffer.from('audio'));

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExec.mock.calls[0];
    expect(file).toBe('python');
    // 固定代码作为 -c 参数，用户输入作为后续独立 argv 元素
    expect((args as string[])[0]).toBe('-c');
    // 绝不应开启 shell（开启才会解释元字符）
    expect((opts as { shell?: boolean }).shell).not.toBe(true);
  });

  it('含 shell 元字符的模型名应被白名单拦截，子进程根本不会被调用', async () => {
    const r = makeReady("base'; touch /tmp/PWNED_X; echo '");
    const res = await r.recognize(Buffer.from('audio'));

    // 校验失败 → 抛错 → 被 catch 降级为空结果，且子进程从未被调用
    expect(mockExec).not.toHaveBeenCalled();
    expect(res.text).toBe('');
    expect(res.confidence).toBe(0);
  });

  it('合法输入：模型名作为独立 argv 元素传入 (sys.argv[1])', async () => {
    const r = makeReady();
    await r.recognize(Buffer.from('audio'));

    const args = mockExec.mock.calls[0][1] as string[];
    // args = ['-c', CODE, model, lang, tmpFile]
    expect(args[2]).toBe('base');
    expect(args[3]).toBe('zh');
    // 临时文件路径落在 tmp 目录且以 .wav 结尾
    expect(args[4]).toMatch(/tmp[\\/][^\\/]+\.wav$/);
  });

  it('validateWhisperInputs 应拒绝含路径穿越的临时文件', () => {
    const r = makeReady();
    expect(() =>
      (r as unknown as {
        validateWhisperInputs: (m: string, l: string, f: string) => void;
      }).validateWhisperInputs('base', 'zh', '/etc/passwd')
    ).toThrow();
  });

  it('validateWhisperInputs 应拒绝非法语言代码', () => {
    const r = makeReady();
    expect(() =>
      (r as unknown as {
        validateWhisperInputs: (m: string, l: string, f: string) => void;
      }).validateWhisperInputs('base', 'zh; rm -rf /', 'tmp/x.wav')
    ).toThrow();
  });

  it('openai-whisper 分支同样使用 argv 数组调用（无 shell）', async () => {
    const r = makeReady();
    (r as unknown as { whisperModel: unknown }).whisperModel = {
      type: 'openai-whisper',
    };
    await r.recognize(Buffer.from('audio'));

    expect(mockExec).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExec.mock.calls[0];
    expect(file).toBe('python');
    expect((args as string[])[0]).toBe('-c');
    expect((opts as { shell?: boolean }).shell).not.toBe(true);
    expect((args as string[])[2]).toBe('base');
  });
});
