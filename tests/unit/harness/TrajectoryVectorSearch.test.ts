import { TrajectoryDatabase } from '../../../src/harness/persistence/TrajectoryDatabase';

describe('TrajectoryDatabase 向量嵌入接入', () => {
  let db: TrajectoryDatabase;

  beforeEach(() => {
    db = new TrajectoryDatabase(':memory:');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  });

  it('应支持设置嵌入函数', () => {
    const embedFn = jest.fn().mockReturnValue([0.1, 0.2, 0.3]);
    db.setEmbedFunction(embedFn);
    expect(embedFn).toBeDefined();
  });

  it('应在记录执行时生成并存储embedding', () => {
    const embedFn = jest.fn().mockReturnValue([0.1, 0.2, 0.3, 0.4]);
    db.setEmbedFunction(embedFn);

    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用到生产环境',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 2,
      total_tool_calls: 3,
      total_duration: 5000,
      created_at: now,
      updated_at: now,
    });

    expect(embedFn).toHaveBeenCalledWith('部署应用到生产环境');
  });

  it('应支持基于向量的语义检索', () => {
    const embedFn = jest.fn().mockImplementation((text: string) => {
      if (text.includes('部署') || text.includes('发布')) return [1, 0, 0];
      return [0, 1, 0];
    });
    db.setEmbedFunction(embedFn);

    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用到生产环境',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 2,
      total_tool_calls: 3,
      total_duration: 5000,
      created_at: now,
      updated_at: now,
    });

    db.recordExecution({
      id: 'exec2',
      input: '查询天气信息',
      status: 'success',
      quality_overall: 0.8,
      loop_rounds: 1,
      total_tool_calls: 1,
      total_duration: 2000,
      created_at: now,
      updated_at: now,
    });

    const results = db.querySimilarTasks('发布应用', { minQualityScore: 0 });

    const exec1Result = results.find((r: any) => r.execution.id === 'exec1');
    expect(exec1Result).toBeDefined();
    expect(exec1Result!.relevanceScore).toBeGreaterThan(0.5);
  });

  it('应在未设置嵌入函数时回退到词频余弦相似度', () => {
    const now = Date.now();
    db.recordExecution({
      id: 'exec1',
      input: '部署应用',
      status: 'success',
      quality_overall: 0.9,
      loop_rounds: 1,
      total_tool_calls: 1,
      total_duration: 1000,
      created_at: now,
      updated_at: now,
    });

    const results = db.querySimilarTasks('部署应用', { minQualityScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });
});
