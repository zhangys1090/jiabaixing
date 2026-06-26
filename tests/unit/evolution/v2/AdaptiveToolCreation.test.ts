/**
 * 阶段 4.2: 自适应工具创建测试
 *
 * 验证核心目标：
 *   - 检测任务能力缺口
 *   - 生成工具规格（ToolSpec）
 *   - 通过 CREATE_TOOL 动作注册新工具
 *   - 新工具可被 ToolRegistry 发现并调用
 *   - 安全边界校验（沙箱执行）
 */

import { SelfModificationEngine } from '../../../../src/evolution/v2/SelfModificationEngine';
import type { ToolSpec } from '../../../../src/evolution/v2/types';
import type { TaskNode } from '../../../../src/harness/orchestration/TaskDispatcher';
import { ToolRegistry } from '../../../../src/harness/tools/registry/ToolRegistry';

jest.mock('../../../../src/utils/Logger', () => ({
  Logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('阶段 4.2: 自适应工具创建', () => {
  describe('能力缺口检测', () => {
    it('检测到任务所需工具不存在时返回缺口', () => {
      const toolRegistry = new ToolRegistry();
      const engine = new SelfModificationEngine({
        toolRegistry,
      } as never);

      const task: TaskNode = {
        id: 't1',
        goal: '解析 PDF 文档',
        context: '',
        dependencies: [],
        priority: 5,
        status: 'pending',
        tools: ['pdf_parse'],
      };

      const gap = engine.detectCapabilityGap(task);

      expect(gap.hasGap).toBe(true);
      expect(gap.missingTools).toContain('pdf_parse');
    });

    it('任务所需工具已存在时无缺口', () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(
        {
          name: 'file_read',
          description: '读取文件',
          category: 'file' as never,
          parameters: {},
          requiredParams: [],
          requiredPermissions: [] as never,
          riskLevel: 'low' as never,
          idempotent: true,
          timeout: 5000,
        },
        async () => ({
          success: true,
          output: 'content',
          duration: 0,
          validated: true,
        })
      );

      const engine = new SelfModificationEngine({
        toolRegistry,
      } as never);

      const task: TaskNode = {
        id: 't1',
        goal: '读取文件',
        context: '',
        dependencies: [],
        priority: 5,
        status: 'pending',
        tools: ['file_read'],
      };

      const gap = engine.detectCapabilityGap(task);

      expect(gap.hasGap).toBe(false);
      expect(gap.missingTools).toHaveLength(0);
    });
  });

  describe('工具规格生成', () => {
    it('根据任务描述生成 ToolSpec', async () => {
      const toolRegistry = new ToolRegistry();
      const llm = {
        chat: jest.fn().mockResolvedValue(
          JSON.stringify({
            name: 'pdf_parse',
            description: '解析 PDF 文档并提取文本',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'PDF 文件路径' },
              },
              required: ['filePath'],
            },
            outputFormat: '{ text: string, pages: number }',
            implementation:
              'async function pdfParse(params) { return { text: "", pages: 0 }; }',
            capabilities: ['pdf', 'document_parsing'],
          })
        ),
      };

      const engine = new SelfModificationEngine({
        toolRegistry,
        llm,
      } as never);

      const spec = await engine.generateToolSpec(
        '解析 PDF 文档并提取文本内容',
        ['pdf_parse']
      );

      expect(spec.name).toBe('pdf_parse');
      expect(spec.description).toContain('PDF');
      expect(spec.capabilities).toContain('pdf');
      expect(spec.implementation).toContain('pdfParse');
    });
  });

  describe('CREATE_TOOL 动作执行', () => {
    it('执行 CREATE_TOOL 动作后工具可被 ToolRegistry 发现', async () => {
      const toolRegistry = new ToolRegistry();
      const engine = new SelfModificationEngine({
        toolRegistry,
      } as never);

      const spec: ToolSpec = {
        name: 'csv_analyze',
        description: '分析 CSV 文件并返回统计信息',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
          },
          required: ['filePath'],
        },
        outputFormat: '{ rows: number, columns: number }',
        implementation:
          'async function csvAnalyze(params) { return { rows: 0, columns: 0 }; }',
        capabilities: ['csv', 'data_analysis'],
      };

      const result = await engine.createTool(spec);

      expect(result.success).toBe(true);
      const registered = toolRegistry.get('csv_analyze');
      expect(registered).toBeDefined();
      expect(registered?.definition.name).toBe('csv_analyze');
    });

    it('重复创建同名工具应被拒绝（幂等保护）', async () => {
      const toolRegistry = new ToolRegistry();
      const engine = new SelfModificationEngine({
        toolRegistry,
      } as never);

      const spec: ToolSpec = {
        name: 'duplicate_tool',
        description: '测试工具',
        inputSchema: { type: 'object', properties: {} },
        outputFormat: '{}',
        implementation: 'async function dup() { return {}; }',
        capabilities: ['test'],
      };

      const first = await engine.createTool(spec);
      expect(first.success).toBe(true);

      const second = await engine.createTool(spec);
      expect(second.success).toBe(false);
      expect(second.error).toContain('已存在');
    });

    it('工具实现含危险调用时被安全边界拦截', async () => {
      const toolRegistry = new ToolRegistry();
      const engine = new SelfModificationEngine({
        toolRegistry,
      } as never);

      const spec: ToolSpec = {
        name: 'dangerous_tool',
        description: '危险工具',
        inputSchema: { type: 'object', properties: {} },
        outputFormat: '{}',
        implementation:
          'async function danger() { require("child_process").execSync("rm -rf /"); }',
        capabilities: ['danger'],
      };

      const result = await engine.createTool(spec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('安全');
    });
  });
});
