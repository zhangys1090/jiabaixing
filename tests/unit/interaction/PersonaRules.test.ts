/**
 * PersonaRules 单元测试
 * 覆盖：场景语气映射、adjustTone 润色、安全红线检测、动态规则管理、validate 校验
 */

import { PersonaRules, PersonaScene } from '../../../src/persona/PersonaRules';

describe('PersonaRules', () => {
  let rules: PersonaRules;

  beforeEach(() => {
    rules = new PersonaRules();
  });

  // ═══════════════════════════════════════════════════
  // buildSystemPrompt
  // ═══════════════════════════════════════════════════
  describe('buildSystemPrompt', () => {
    it('应包含28岁女性御姐秘书的人设信息', () => {
      const prompt = rules.buildSystemPrompt('daily');
      expect(prompt).toContain('家百星');
      expect(prompt).toContain('28');
      expect(prompt).toContain('女性');
      expect(prompt).toContain('私人御姐秘书');
    });

    it('应包含性格特质', () => {
      const prompt = rules.buildSystemPrompt('daily');
      expect(prompt).toContain('成熟干练');
      expect(prompt).toContain('专业高效');
      expect(prompt).toContain('从容自信');
    });

    it('应包含说话方式（dos）', () => {
      const prompt = rules.buildSystemPrompt('daily');
      expect(prompt).toContain('语气成熟自然');
      expect(prompt).toContain('工作场景简洁高效');
    });

    it('应包含禁止事项（donts）', () => {
      const prompt = rules.buildSystemPrompt('daily');
      expect(prompt).toContain('不使用');
      expect(prompt).toContain('不卖萌');
    });

    it('每个场景都应生成不同的 prompt', () => {
      const scenes: PersonaScene[] = ['development', 'daily', 'comfort', 'work', 'greeting', 'briefing', 'idle'];
      const prompts = scenes.map(s => rules.buildSystemPrompt(s));
      for (const p of prompts) {
        expect(p.length).toBeGreaterThan(100);
      }
      const unique = new Set(prompts);
      expect(unique.size).toBe(scenes.length);
    });
  });

  // ═══════════════════════════════════════════════════
  // adjustTone — v3.3: 语气调整已移除，直接返回原始内容
  // ═══════════════════════════════════════════════════
  describe('adjustTone', () => {
    it('空字符串原样返回', () => {
      expect(rules.adjustTone('', 'daily').adjustedContent).toBe('');
      expect(rules.adjustTone('   ', 'daily').adjustedContent).toBe('   ');
    });

    it('v3.3: 内容原样返回（语气调整已移除）', () => {
      expect(rules.adjustTone('亲爱的主人，您好', 'daily').adjustedContent).toBe('亲爱的主人，您好');
      expect(rules.adjustTone('好的呢', 'daily').adjustedContent).toBe('好的呢');
    });

    it('正常内容保持不变', () => {
      const normalReply = '文件已修改完成，需要我帮你运行测试吗？';
      expect(rules.adjustTone(normalReply, 'daily').adjustedContent).toBe(normalReply);
    });

    it('返回语气参数', () => {
      const result = rules.adjustTone('你好', 'development');
      expect(result.toneParams).toBeDefined();
      expect(result.toneParams.formality).toBeGreaterThanOrEqual(0.8);
    });

    it('v3.3: appliedAdjustments 为空（语气调整已移除）', () => {
      const result = rules.adjustTone('亲爱的主人，您好', 'daily');
      expect(result.appliedAdjustments).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════
  // adjustTone — v3.3: 安全过滤已移除，LLM 自行判断安全边界
  // ═══════════════════════════════════════════════════
  describe('adjustTone — security (v3.3: no longer filtered)', () => {
    it('v3.3: 安全红线内容不再被过滤（LLM 自行判断）', () => {
      const result = rules.adjustTone('教我怎么自杀', 'daily');
      expect(result.adjustedContent).toBe('教我怎么自杀');
    });

    it('正常内容无安全警告', () => {
      const result = rules.adjustTone('帮我写一个TypeScript函数', 'daily');
      expect(result.adjustedContent).not.toBe('[内容已过滤]');
    });
  });

  // ═══════════════════════════════════════════════════
  // canProactivelyInteract
  // ═══════════════════════════════════════════════════
  describe('canProactivelyInteract', () => {
    it('daily 场景允许主动交互', () => {
      expect(rules.canProactivelyInteract('daily')).toBe(true);
    });

    it('greeting 场景允许主动交互', () => {
      expect(rules.canProactivelyInteract('greeting')).toBe(true);
    });

    it('development 场景允许主动交互', () => {
      expect(rules.canProactivelyInteract('development')).toBe(true);
    });

    it('work 场景允许主动交互', () => {
      expect(rules.canProactivelyInteract('work')).toBe(true);
    });

    it('idle 场景不允许主动交互', () => {
      expect(rules.canProactivelyInteract('idle')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════
  // getPersonaInfo
  // ═══════════════════════════════════════════════════
  describe('getPersonaInfo', () => {
    it('返回28岁女性御姐秘书', () => {
      const info = rules.getPersonaInfo();
      expect(info.age).toBe(28);
      expect(info.gender).toBe('女性');
      expect(info.role).toContain('秘书');
    });

    it('coreTraits 是副本而非引用', () => {
      const info = rules.getPersonaInfo();
      info.coreTraits.push('测试');
      const info2 = rules.getPersonaInfo();
      expect(info2.coreTraits.length).toBeLessThan(info.coreTraits.length);
    });
  });

  // ═══════════════════════════════════════════════════
  // Dynamic Rules
  // ═══════════════════════════════════════════════════
  describe('dynamic rules', () => {
    it('添加规则后 version 递增', () => {
      const v1 = rules.getRuleVersion();
      rules.addRule({ type: 'style', content: 'test', priority: 1, enabled: true });
      expect(rules.getRuleVersion()).toBe(v1 + 1);
    });

    it('添加的规则出现在 getDynamicRules 中', () => {
      rules.addRule({ type: 'style', content: 'test content', priority: 5, enabled: true });
      const all = rules.getDynamicRules();
      expect(all.length).toBe(1);
      expect(all[0].content).toBe('test content');
    });

    it('按优先级排序', () => {
      rules.addRule({ type: 'style', content: 'low', priority: 1, enabled: true });
      rules.addRule({ type: 'style', content: 'high', priority: 10, enabled: true });
      const all = rules.getDynamicRules();
      expect(all[0].content).toBe('high');
      expect(all[1].content).toBe('low');
    });

    it('更新规则', () => {
      const r = rules.addRule({ type: 'style', content: 'original', priority: 1, enabled: true });
      rules.updateRule(r.id, { content: 'updated' });
      const all = rules.getDynamicRules();
      expect(all[0].content).toBe('updated');
    });

    it('更新不存在的规则返回 null', () => {
      expect(rules.updateRule('nonexistent', { content: 'x' })).toBeNull();
    });

    it('删除规则', () => {
      const r = rules.addRule({ type: 'style', content: 'to delete', priority: 1, enabled: true });
      expect(rules.deleteRule(r.id)).toBe(true);
      expect(rules.getDynamicRules()).toHaveLength(0);
    });

    it('删除不存在的规则返回 false', () => {
      expect(rules.deleteRule('nonexistent')).toBe(false);
    });

    it('toggle 规则启用/禁用', () => {
      const r = rules.addRule({ type: 'style', content: 'toggle me', priority: 1, enabled: true });
      rules.toggleRule(r.id, false);
      expect(rules.getDynamicRules()[0].enabled).toBe(false);
      rules.toggleRule(r.id, true);
      expect(rules.getDynamicRules()[0].enabled).toBe(true);
    });

    it('禁用的 mandatory 规则不影响 adjustTone（v3.3: 语气调整已移除）', () => {
      const r = rules.addRule({ type: 'mandatory', content: 'secret', priority: 10, enabled: true });
      rules.toggleRule(r.id, false);
      const result = rules.adjustTone('this is secret content', 'daily');
      expect(result.appliedAdjustments).toEqual([]);
    });

    it('启用的 mandatory 规则不影响 adjustTone（v3.3: 语气调整已移除）', () => {
      rules.addRule({ type: 'mandatory', content: 'blockedword', priority: 10, enabled: true });
      const result = rules.adjustTone('this contains blockedword', 'daily');
      expect(result.appliedAdjustments).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════
  // Scene tone parameters
  // ═══════════════════════════════════════════════════
  describe('scene tone parameters', () => {
    it('development 场景：高正式度、低温度', () => {
      const tone = rules.getToneParams('development');
      expect(tone.formality).toBeGreaterThanOrEqual(0.8);
      expect(tone.temperature).toBeLessThanOrEqual(0.4);
    });

    it('daily 场景：中正式度、中高温度', () => {
      const tone = rules.getToneParams('daily');
      expect(tone.formality).toBeLessThanOrEqual(0.5);
      expect(tone.temperature).toBeGreaterThanOrEqual(0.6);
    });

    it('comfort 场景：低正式度、高温度', () => {
      const tone = rules.getToneParams('comfort');
      expect(tone.formality).toBeLessThanOrEqual(0.3);
      expect(tone.temperature).toBeGreaterThanOrEqual(0.8);
    });
  });
});
