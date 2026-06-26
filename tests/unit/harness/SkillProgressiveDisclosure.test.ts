import { SkillRegistry } from '../../../src/skills/SkillRegistry';
import {
  Skill,
  SkillDefinition,
  SkillSection,
} from '../../../src/skills/SkillInterface';

describe('Skill Progressive Disclosure', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    SkillRegistry.resetInstance();
    registry = SkillRegistry.getInstance();
  });

  afterEach(() => {
    SkillRegistry.resetInstance();
  });

  it('应返回技能摘要而非完整内容', () => {
    const skill: Skill = {
      definition: {
        name: 'react-patterns',
        description: 'React 设计模式',
        version: '1.0',
        category: 'frontend',
        tags: ['react', 'patterns'],
        parameters: [],
      } as SkillDefinition,
      summary: 'React 组件设计模式集合：HOC、Render Props、Hooks',
      sections: [
        { title: 'HOC 模式', content: '高阶组件的详细说明...' },
        { title: 'Render Props', content: 'Render Props 的详细说明...' },
        { title: 'Custom Hooks', content: '自定义 Hooks 的详细说明...' },
      ],
      execute: async () => ({ success: true, output: '' }),
      validate: async () => ({ valid: true, errors: [] }),
    };

    registry.register(skill);

    const summaries = registry.getSkillSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('react-patterns');
    expect(summaries[0].summary).toBe(
      'React 组件设计模式集合：HOC、Render Props、Hooks'
    );
    expect(summaries[0].sectionCount).toBe(3);
    expect(summaries[0].charCount).toBeLessThan(100);
  });

  it('应按需展开技能的特定章节', () => {
    const skill: Skill = {
      definition: {
        name: 'react-patterns',
        description: 'React 设计模式',
        version: '1.0',
        category: 'frontend',
        tags: [],
        parameters: [],
      } as SkillDefinition,
      summary: 'React 组件设计模式集合',
      sections: [
        { title: 'HOC 模式', content: '高阶组件的详细说明...' },
        { title: 'Render Props', content: 'Render Props 的详细说明...' },
      ],
      execute: async () => ({ success: true, output: '' }),
      validate: async () => ({ valid: true, errors: [] }),
    };

    registry.register(skill);

    const expanded = registry.expandSkillSection('react-patterns', 'HOC 模式');
    expect(expanded).toBeDefined();
    expect(expanded!.title).toBe('HOC 模式');
    expect(expanded!.content).toContain('高阶组件');
  });

  it('展开不存在的章节应返回 null', () => {
    const skill: Skill = {
      definition: {
        name: 'test-skill',
        description: '测试',
        version: '1.0',
        category: 'test',
        tags: [],
        parameters: [],
      } as SkillDefinition,
      summary: '测试技能',
      sections: [],
      execute: async () => ({ success: true, output: '' }),
      validate: async () => ({ valid: true, errors: [] }),
    };

    registry.register(skill);

    const expanded = registry.expandSkillSection('test-skill', '不存在');
    expect(expanded).toBeNull();
  });

  it('应生成 token 优化的上下文注入文本', () => {
    const skill: Skill = {
      definition: {
        name: 'typescript-tips',
        description: 'TypeScript 技巧',
        version: '1.0',
        category: 'language',
        tags: [],
        parameters: [],
      } as SkillDefinition,
      summary: 'TypeScript 高级类型技巧',
      sections: [
        { title: '条件类型', content: '条件类型的详细说明...' },
        { title: '映射类型', content: '映射类型的详细说明...' },
      ],
      execute: async () => ({ success: true, output: '' }),
      validate: async () => ({ valid: true, errors: [] }),
    };

    registry.register(skill);

    const contextText = registry.generateSummaryContext();
    expect(contextText).toContain('typescript-tips');
    expect(contextText).toContain('TypeScript 高级类型技巧');
    expect(contextText).not.toContain('条件类型的详细说明');
  });

  it('无技能时应返回空字符串', () => {
    const contextText = registry.generateSummaryContext();
    expect(contextText).toBe('');
  });

  it('无 summary 时应使用 description', () => {
    const skill: Skill = {
      definition: {
        name: 'no-summary',
        description: '这是描述',
        version: '1.0',
        category: 'test',
        tags: [],
        parameters: [],
      } as SkillDefinition,
      execute: async () => ({ success: true, output: '' }),
      validate: async () => ({ valid: true, errors: [] }),
    };

    registry.register(skill);

    const summaries = registry.getSkillSummaries();
    expect(summaries[0].summary).toBe('这是描述');
  });
});
