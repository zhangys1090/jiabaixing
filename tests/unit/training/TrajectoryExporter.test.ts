import {
  TrajectoryExporter,
  ExportFormat,
} from '../../../src/training/TrajectoryExporter';
import type { TrajectoryData } from '../../../src/training/TrajectoryExporter';

describe('TrajectoryExporter', () => {
  const sampleTrajectories: TrajectoryData[] = [
    {
      id: 't1',
      steps: [
        { role: 'user', content: '写代码' },
        {
          role: 'assistant',
          content: '好的',
          toolCalls: [{ name: 'file_read', params: {} }],
        },
        { role: 'tool', content: '文件内容' },
        { role: 'assistant', content: '代码如下...' },
      ],
      quality: 0.9,
    },
    {
      id: 't2',
      steps: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      quality: 0.5,
    },
    {
      id: 't3',
      steps: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '分析代码' },
        { role: 'assistant', content: '分析结果...' },
      ],
      quality: 0.8,
    },
  ];

  it('应导出为 ShareGPT 格式', () => {
    const exporter = new TrajectoryExporter();
    const exported = exporter.toShareGPT(sampleTrajectories);

    expect(exported).toHaveLength(3);
    expect(exported[0].conversations[0]).toEqual({
      from: 'human',
      value: '写代码',
    });
    expect(exported[0].conversations[1]).toEqual({
      from: 'gpt',
      value: '好的',
    });
  });

  it('应按质量分数过滤轨迹', () => {
    const exporter = new TrajectoryExporter({ minQuality: 0.7 });
    const filtered = exporter.filterByQuality(sampleTrajectories);

    expect(filtered).toHaveLength(2);
    expect(filtered.every((t) => t.quality >= 0.7)).toBe(true);
  });

  it('应导出为 JSONL 格式', () => {
    const exporter = new TrajectoryExporter();
    const jsonl = exporter.toJSONL(sampleTrajectories);

    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).id).toBe('t1');
  });

  it('应导出为 OpenAI Fine-tuning 格式', () => {
    const exporter = new TrajectoryExporter();
    const exported = exporter.toOpenAIFineTune(sampleTrajectories);

    expect(exported).toHaveLength(3);
    expect(exported[0].messages[0].role).toBe('user');
    expect(exported[0].messages[1].role).toBe('assistant');
  });

  it('应通过通用 export 方法导出', () => {
    const exporter = new TrajectoryExporter();

    const sharegpt = exporter.export(sampleTrajectories, ExportFormat.SHAREGPT);
    expect(Array.isArray(sharegpt)).toBe(true);

    const jsonl = exporter.export(sampleTrajectories, ExportFormat.JSONL);
    expect(typeof jsonl).toBe('string');
  });

  it('应生成轨迹统计信息', () => {
    const exporter = new TrajectoryExporter({ minQuality: 0.7 });
    const stats = exporter.getStats(sampleTrajectories);

    expect(stats.total).toBe(3);
    expect(stats.filtered).toBe(2);
    expect(stats.avgQuality).toBeGreaterThan(0);
    expect(stats.avgSteps).toBeGreaterThan(0);
  });

  it('ShareGPT 格式应过滤 tool 角色', () => {
    const exporter = new TrajectoryExporter();
    const exported = exporter.toShareGPT(sampleTrajectories);

    const toolConversations = exported[0].conversations.filter(
      (c) => (c as { from: string }).from === 'tool'
    );
    expect(toolConversations).toHaveLength(0);
  });

  it('OpenAI 格式应包含 system 角色', () => {
    const exporter = new TrajectoryExporter();
    const exported = exporter.toOpenAIFineTune(sampleTrajectories);

    const systemMessages = exported[2].messages.filter(
      (m) => m.role === 'system'
    );
    expect(systemMessages).toHaveLength(1);
  });
});
