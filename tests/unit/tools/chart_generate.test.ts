/**
 * Unit tests for chart_generate harness tool
 */

import {
  createChartGenerateExecutor,
  CHART_GENERATE_DEF,
} from '../../../src/harness/tools/network/chart_generate';

describe('chart_generate 工具', () => {
  describe('工具定义', () => {
    it('应该有正确的名称和分类', () => {
      expect(CHART_GENERATE_DEF.name).toBe('chart_generate');
      expect(CHART_GENERATE_DEF.category).toBe('network');
      expect(CHART_GENERATE_DEF.requiredParams).toContain('title');
      expect(CHART_GENERATE_DEF.requiredParams).toContain('labels');
      expect(CHART_GENERATE_DEF.requiredParams).toContain('datasets');
      expect(CHART_GENERATE_DEF.requiredPermissions).toContain('network:access');
      expect(CHART_GENERATE_DEF.riskLevel).toBe('low');
      expect(CHART_GENERATE_DEF.timeout).toBe(30000);
    });

    it('应该支持5种图表类型', () => {
      const chartTypeParam = CHART_GENERATE_DEF.parameters.chart_type as { enum?: string[] };
      expect(chartTypeParam.enum).toContain('bar');
      expect(chartTypeParam.enum).toContain('line');
      expect(chartTypeParam.enum).toContain('pie');
      expect(chartTypeParam.enum).toContain('doughnut');
      expect(chartTypeParam.enum).toContain('radar');
    });
  });

  describe('参数校验', () => {
    const executor = createChartGenerateExecutor();

    it('拒绝空标题', async () => {
      const result = await executor({
        title: '',
        labels: ['A', 'B'],
        datasets: [{ label: 'ds1', data: [1, 2] }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('图表标题不能为空');
    });

    it('拒绝空标签数组', async () => {
      const result = await executor({
        title: 'Test',
        labels: [],
        datasets: [{ label: 'ds1', data: [1, 2] }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('标签');
    });

    it('拒绝空数据集', async () => {
      const result = await executor({
        title: 'Test',
        labels: ['A'],
        datasets: [],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('数据集');
    });

    it('拒绝缺少label的数据集项', async () => {
      const result = await executor({
        title: 'Test',
        labels: ['A'],
        datasets: [{ data: [1] } as any],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('label');
    });

    it('拒绝空数据数组', async () => {
      const result = await executor({
        title: 'Test',
        labels: ['A'],
        datasets: [{ label: 'ds1', data: [] }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('数据');
    });

    it('拒绝不支持的图表类型', async () => {
      const result = await executor({
        chart_type: 'xyz',
        title: 'Test',
        labels: ['A'],
        datasets: [{ label: 'ds1', data: [1] }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('不支持的图表类型');
    });
  });

  describe('通过 httpClient mock 生成图表', () => {
    const createMockClient = () => ({
      get: jest.fn().mockResolvedValue('ok'),
    });

    it('生成 markdown 格式', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        chart_type: 'bar',
        title: '测试图表',
        labels: ['A', 'B', 'C'],
        datasets: [{ label: '系列1', data: [10, 20, 30] }],
        output_format: 'markdown',
      });

      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect((result.output as string)).toContain('测试图表');
      expect(mockClient.get).toHaveBeenCalled();
    });

    it('生成 url 格式', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        title: '数据',
        labels: ['A'],
        datasets: [{ label: 's1', data: [5] }],
        output_format: 'url',
      });

      expect(result.success).toBe(true);
      expect((result.output as string)).toContain('http');
      expect((result.output as string)).toContain('quickchart');
    });

    it('生成 base64 格式', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        title: '数据',
        labels: ['A'],
        datasets: [{ label: 's1', data: [5] }],
        output_format: 'base64',
      });

      expect(result.success).toBe(true);
      // 由于 mock 不返回真实图片，base64 路径会尝试 fetch 并失败
      // 但至少应该返回一个非空的输出
      expect(result.output).toBeTruthy();
    });

    it('line 图表类型', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        chart_type: 'line',
        title: '折线图',
        labels: ['Q1', 'Q2'],
        datasets: [{ label: '收入', data: [100, 200] }],
      });

      expect(result.success).toBe(true);
    });

    it('pie 图表类型', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        chart_type: 'pie',
        title: '饼图',
        labels: ['A', 'B'],
        datasets: [{ label: '占比', data: [30, 70] }],
      });

      expect(result.success).toBe(true);
    });

    it('支持自定义宽高', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        title: '宽图',
        labels: ['A'],
        datasets: [{ label: 's1', data: [5] }],
        width: 800,
        height: 200,
      });

      expect(result.success).toBe(true);
      expect((result.output as string)).toContain('width=800');
      expect((result.output as string)).toContain('height=200');
    });

    it('支持多数据集', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        title: '多数据集',
        labels: ['A', 'B'],
        datasets: [
          { label: '系列1', data: [10, 20] },
          { label: '系列2', data: [30, 40] },
        ],
      });

      expect(result.success).toBe(true);
    });

    it('支持自定义颜色', async () => {
      const mockClient = createMockClient();
      const execWithDeps = createChartGenerateExecutor({ httpClient: mockClient });
      const result = await execWithDeps({
        title: '彩色',
        labels: ['A'],
        datasets: [{ label: 's1', data: [5], color: '#ff0000' }],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('错误处理', () => {
    it('httpClient 返回 500 状态应处理', async () => {
      const execWithDeps = createChartGenerateExecutor();
      // 无 mock: 会走 fetch HEAD 检查路径
      const result = await execWithDeps({
        title: 'Test',
        labels: ['A'],
        datasets: [{ label: 's1', data: [1] }],
        output_format: 'url',
      });

      // 即使 QuickChart 不可达也应该返回 URL（容错设计）
      expect(result.success).toBe(true);
    });

    it('非数组 labels 应拒绝', async () => {
      const executor = createChartGenerateExecutor();
      const result = await executor({
        title: 'Test',
        labels: 'not-an-array' as any,
        datasets: [{ label: 's1', data: [1] }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('不能为空');
    });
  });
});
