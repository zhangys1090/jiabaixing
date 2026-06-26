import { SkillRegistry } from '../../../src/skills/SkillRegistry';

describe('智能飞轮: Skill 提取闭环', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = SkillRegistry.getInstance();
    const existing = registry.getAllSkills();
    for (const s of existing) {
      registry.unregister(s.definition.name);
    }
  });

  describe('extractAndRegisterSkill', () => {
    it('应从高质量轨迹提取 Skill', async () => {
      const skillName = await registry.extractAndRegisterSkill({
        input: '搜索天气数据并分析趋势',
        intent: 'weather_analysis',
        toolSequence: [
          {
            toolName: 'web_search',
            args: { query: '北京天气' },
            success: true,
            output: '搜索结果',
          },
          {
            toolName: 'code_analyze',
            args: { code: 'temp_data' },
            success: true,
            output: '分析完成',
          },
        ],
        qualityScore: 0.85,
      });

      expect(skillName).not.toBeNull();
      expect(skillName).toContain('auto_');

      const skill = registry.getSkill(skillName!);
      expect(skill).toBeDefined();
      expect(skill!.definition.source).toBe('evolution');
      expect(skill!.definition.category).toBe('auto_extracted');
      expect(skill!.definition.tags).toContain('search');
      expect(skill!.definition.tags).toContain('weather');
      expect(skill!.sections).toBeDefined();
      expect(skill!.sections!.length).toBeGreaterThan(0);
    });

    it('质量低于阈值不应提取', async () => {
      const result = await registry.extractAndRegisterSkill({
        input: '低质量任务',
        intent: 'low_quality',
        toolSequence: [
          { toolName: 'file_search', args: { pattern: '*.ts' }, success: true },
        ],
        qualityScore: 0.5,
      });

      expect(result).toBeNull();
    });

    it('工具步骤少于2不应提取', async () => {
      const result = await registry.extractAndRegisterSkill({
        input: '简单任务',
        intent: 'simple',
        toolSequence: [
          { toolName: 'file_search', args: { pattern: '*.ts' }, success: true },
        ],
        qualityScore: 0.9,
      });

      expect(result).toBeNull();
    });

    it('有失败步骤不应提取', async () => {
      const result = await registry.extractAndRegisterSkill({
        input: '部分失败任务',
        intent: 'partial_fail',
        toolSequence: [
          { toolName: 'file_search', args: { pattern: '*.ts' }, success: true },
          {
            toolName: 'shell_exec',
            args: { command: 'rm -rf' },
            success: false,
          },
        ],
        qualityScore: 0.8,
      });

      expect(result).toBeNull();
    });

    it('重复提取相同模式不应覆盖', async () => {
      const first = await registry.extractAndRegisterSkill({
        input: '搜索代码',
        intent: 'codesearch',
        toolSequence: [
          { toolName: 'file_search', args: { pattern: '*.ts' }, success: true },
          { toolName: 'file_read', args: { path: '/test.ts' }, success: true },
        ],
        qualityScore: 0.9,
      });

      const second = await registry.extractAndRegisterSkill({
        input: '搜索代码',
        intent: 'codesearch',
        toolSequence: [
          { toolName: 'file_search', args: { pattern: '*.ts' }, success: true },
          { toolName: 'file_read', args: { path: '/test.ts' }, success: true },
        ],
        qualityScore: 0.9,
      });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('提取的 Skill 可执行', async () => {
      const skillName = await registry.extractAndRegisterSkill({
        input: '搜索天气数据并分析趋势',
        intent: 'weather_analysis',
        toolSequence: [
          {
            toolName: 'web_search',
            args: { query: '北京天气' },
            success: true,
            output: '搜索结果',
          },
          {
            toolName: 'code_analyze',
            args: { code: 'temp_data' },
            success: true,
            output: '分析完成',
          },
        ],
        qualityScore: 0.85,
      });

      const skill = registry.getSkill(skillName!);
      const result = await skill!.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      expect(result.metadata!.source).toBe('auto_extracted');
    });
  });

  describe('findRelevantSkillsPrompt', () => {
    it('无注册 Skill 时返回空字符串', () => {
      const prompt = registry.findRelevantSkillsPrompt('搜索文件');
      expect(prompt).toBe('');
    });

    it('有匹配 Skill 时返回提示词', async () => {
      await registry.extractAndRegisterSkill({
        input: '搜索天气数据并分析趋势',
        intent: 'weather_analysis',
        toolSequence: [
          {
            toolName: 'web_search',
            args: { query: '天气' },
            success: true,
            output: '搜索结果',
          },
          {
            toolName: 'code_analyze',
            args: { code: 'data' },
            success: true,
            output: '分析完成',
          },
        ],
        qualityScore: 0.85,
      });

      const prompt = registry.findRelevantSkillsPrompt('天气搜索');
      expect(prompt).toContain('相关技能参考');
      expect(prompt).toContain('auto_');
    });
  });

  describe('参数泛化', () => {
    it('路径参数应泛化为 <path>', async () => {
      const skillName = await registry.extractAndRegisterSkill({
        input: '读取文件内容',
        intent: 'file_read',
        toolSequence: [
          { toolName: 'file_search', args: { pattern: '*.ts' }, success: true },
          {
            toolName: 'file_read',
            args: { path: '/home/user/test.ts' },
            success: true,
          },
        ],
        qualityScore: 0.9,
      });

      const skill = registry.getSkill(skillName!);
      const stepsSection = skill!.sections!.find((s) => s.title === '执行步骤');
      expect(stepsSection!.content).toContain('<path>');
    });

    it('URL 参数应泛化为 <url>', async () => {
      const skillName = await registry.extractAndRegisterSkill({
        input: '获取网页内容',
        intent: 'web_fetch',
        toolSequence: [
          { toolName: 'web_search', args: { query: 'test' }, success: true },
          {
            toolName: 'web_fetch',
            args: { url: 'https://example.com/api' },
            success: true,
          },
        ],
        qualityScore: 0.9,
      });

      const skill = registry.getSkill(skillName!);
      const stepsSection = skill!.sections!.find((s) => s.title === '执行步骤');
      expect(stepsSection!.content).toContain('<url>');
    });
  });

  describe('飞轮闭环验证', () => {
    it('完整闭环: 提取 → 发现 → 注入', async () => {
      await registry.extractAndRegisterSkill({
        input: '搜索代码文件并分析代码质量',
        intent: 'code_analysis',
        toolSequence: [
          {
            toolName: 'file_search',
            args: { pattern: '*.ts' },
            success: true,
            output: '找到5个文件',
          },
          {
            toolName: 'code_analyze',
            args: { code: 'src/main.ts' },
            success: true,
            output: '质量评分0.8',
          },
        ],
        qualityScore: 0.9,
      });

      const matches = registry.discoverSkills('代码分析', 3);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].skill.definition.source).toBe('evolution');

      const prompt = registry.findRelevantSkillsPrompt('代码分析');
      expect(prompt).toContain('相关技能参考');
      expect(prompt).toContain('auto_');
    });
  });
});
