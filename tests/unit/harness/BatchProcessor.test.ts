import {
  BatchProcessor,
  BatchItemResult,
} from '../../../src/harness/batch/BatchProcessor';

describe('BatchProcessor', () => {
  it('应并行处理多个 prompt', async () => {
    const processor = new BatchProcessor({
      concurrency: 3,
      timeout: 30000,
    });

    const prompts = [
      { id: '1', text: '你好' },
      { id: '2', text: '写一个函数' },
      { id: '3', text: '分析代码' },
    ];

    const results = await processor.run(prompts, async (prompt) => ({
      id: prompt.id,
      response: `回复: ${prompt.text}`,
      success: true,
      duration: 10,
    }));

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('应限制并发数', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const processor = new BatchProcessor({
      concurrency: 2,
      timeout: 5000,
    });

    const prompts = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      text: `prompt ${i}`,
    }));

    await processor.run(prompts, async (prompt) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrent--;
      return { id: prompt.id, response: 'ok', success: true, duration: 50 };
    });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('应生成 ShareGPT 格式轨迹', async () => {
    const processor = new BatchProcessor({
      concurrency: 1,
      timeout: 5000,
    });

    const results: BatchItemResult[] = [
      { id: 'hello', response: 'hi', success: true, duration: 10 },
    ];

    const sharegpt = processor.toShareGPT(results);
    expect(sharegpt.conversations).toBeDefined();
    expect(sharegpt.conversations[0]).toEqual({
      from: 'human',
      value: 'hello',
    });
    expect(sharegpt.conversations[1]).toEqual({
      from: 'gpt',
      value: 'hi',
    });
  });

  it('应生成 JSONL 格式', async () => {
    const processor = new BatchProcessor({
      concurrency: 1,
      timeout: 5000,
    });

    const results: BatchItemResult[] = [
      { id: '1', response: 'a', success: true, duration: 10 },
      { id: '2', response: 'b', success: true, duration: 10 },
    ];

    const jsonl = processor.toJSONL(results);
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('1');
  });

  it('应处理执行超时', async () => {
    const processor = new BatchProcessor({
      concurrency: 1,
      timeout: 50, // 50ms 超时
    });

    const results = await processor.run(
      [{ id: '1', text: 'slow' }],
      async () => {
        await new Promise((r) => setTimeout(r, 200)); // 200ms 执行
        return { id: '1', response: 'ok', success: true, duration: 200 };
      }
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('超时');
  });

  it('应处理执行错误', async () => {
    const processor = new BatchProcessor({
      concurrency: 1,
      timeout: 5000,
    });

    const results = await processor.run(
      [{ id: '1', text: 'error' }],
      async () => {
        throw new Error('执行失败');
      }
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('执行失败');
  });
});
