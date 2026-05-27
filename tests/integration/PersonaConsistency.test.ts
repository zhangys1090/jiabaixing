/**
 * 人格一致性集成测试
 * 连续 100 轮对话，语气、自称、边界无崩坏，符合御姐秘书设定
 */

import { PersonaCore } from '../../src/persona/PersonaCore';
import { PersonaRules } from '../../src/persona/PersonaRules';

describe('Persona Consistency (Integration)', () => {
  let personaCore: PersonaCore;
  let personaRules: PersonaRules;

  const testConversations: string[] = [
    '你好',
    '今天天气不错',
    '帮我看看代码',
    '我心情不太好',
    '晚安',
    '早上好',
    '这个项目用什么框架好',
    '谢谢你',
    '你在吗',
    '帮我查一下日程',
    '写个函数',
    '我觉得最近效率不高',
    '周末有什么推荐',
    '帮我算一下这个',
    '再见',
    '你能做什么',
    '你叫什么名字',
    '你多大了',
    '你是什么',
    '你和我是什么关系',
    '今天有什么安排',
    '帮我写个Python脚本',
    '这个bug怎么修',
    '我累了',
    '明天要开会',
    '代码重构建议',
    '帮我优化这段代码',
    '文件的命名规范是什么',
    '你记得我之前说的吗',
    '给我讲个笑话？不，还是算了',
    '数据备份做好了没',
    '这个API怎么调',
    '部署流程是什么',
    '帮我做个PPT大纲',
    '今天的工作总结',
    '帮我找个文件',
    '你知道我喜欢什么语言吗',
    '下周计划',
    '提醒我下午3点开会',
    '帮我测试这个接口',
    '你的性格是什么样的',
    '你会生气吗',
    '你会忘记我说过的话吗',
    '你觉得我最近怎么样',
    '有什么好的学习资源',
    '帮我翻译一下',
    '这个报告怎么优化',
    '陪我聊会儿',
    '我该不该换工作',
    '帮我分析一下数据',
    '你帮我记得这么清楚，谢谢',
    '有没有什么好电影推荐',
    '最近压力大',
    '帮我整理一下笔记',
    '代码审查结果',
    '帮我发个邮件',
    '你猜我在想什么',
    '我饿了',
    '今天吃什么',
    '帮我订个外卖',
    '你工作效率真高',
    '你还在吗',
    '我回来了',
    '继续刚才的话题',
    '这个方案的优缺点',
    '帮我做个决策分析',
    '有什么新闻',
    '帮我监控一下服务器',
    '这个配置有问题',
    '你怎么看这个问题',
    '你越来越懂我了',
    '我最近总是失眠',
    '帮我设置一个提醒',
    '项目进度怎么样了',
    '帮我做一下代码review',
    '这个算法复杂度分析',
    '你确定吗',
    '我觉得你不错',
    '你的建议很有用',
    '帮我查一下邮件',
    '今天的股票行情',
    '帮我写个正则',
    '数据库查询优化',
    '帮我画个架构图',
    '你说话越来越自然了',
    '我有点烦',
    '帮我冷静分析一下',
    '这个项目能按时完成吗',
    '你有什么建议',
    '帮我记录一下这个想法',
    '你觉得我适合学什么',
    '帮我比较一下这两个方案',
    '你的记忆真好',
    '谢谢你的提醒',
    '我今天很开心',
    '帮我找个API文档',
    '测试覆盖率检查',
    '帮我部署一下',
    '我需要休息一下',
    '改天请你吃饭',
    '你真是个可靠的助手',
    '明天见',
    '谢谢你一直陪着我',
  ];

  beforeAll(() => {
    personaCore = new PersonaCore();
    personaRules = new PersonaRules(personaCore);
  });

  describe('100-round conversation consistency', () => {
    it('should maintain persona across all 100 conversations', () => {
      for (let i = 0; i < testConversations.length; i++) {
        const input = testConversations[i];
        const toneResult = personaRules.adjustTone(`这是对"${input}"的回复内容。好的，我明白了，会帮你处理。`, i < 20 ? 'development' : i < 40 ? 'daily' : i < 60 ? 'comfort' : i < 80 ? 'work' : 'daily');

        const validation = personaRules.validate(toneResult.adjustedContent);
        expect(validation.isValid).toBe(true);

        if (validation.warnings.length > 0) {
          console.warn(`第 ${i + 1} 轮对话警告: ${validation.warnings.join(', ')}`);
        }
      }
    });
  });

  describe('scene tone adjustments', () => {
    it('should produce formal tone for development scene', () => {
      const tone = personaCore.getToneForScene('development');
      expect(tone.formality).toBeGreaterThanOrEqual(0.7);
      expect(tone.temperature).toBeLessThanOrEqual(0.5);
      expect(tone.emojiFrequency).toBe(0);
    });

    it('should produce warm tone for daily scene', () => {
      const tone = personaCore.getToneForScene('daily');
      expect(tone.temperature).toBeGreaterThanOrEqual(0.6);
      expect(tone.formality).toBeLessThanOrEqual(0.5);
      expect(tone.proactive).toBe(true);
    });

    it('should be proactive for comfort scene', () => {
      const tone = personaCore.getToneForScene('comfort');
      expect(tone.temperature).toBeGreaterThanOrEqual(0.8);
      expect(tone.proactive).toBe(true);
    });
  });

  describe('safety boundaries', () => {
    it('should detect security redlines', () => {
      const result = personaRules.adjustTone('我想自杀', 'daily');
      expect(result.warnings.length).toBeGreaterThan(0);

      const validation = personaRules.validate('我想自杀');
      expect(validation.isValid).toBe(false);
    });

    it('should not block normal conversation', () => {
      const result = personaRules.adjustTone('今天天气不错，适合出去走走', 'daily');
      expect(result.adjustedContent).toContain('今天');
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('forced title removal', () => {
    it('should remove forced titles', () => {
      const input = '亲爱的主人，我已经帮你处理好了';
      const result = personaRules.adjustTone(input, 'daily');
      expect(result.adjustedContent).not.toContain('亲爱的主人');
      expect(result.appliedAdjustments).toContain('removed_forced_title');
    });

    it('should remove childish tone words', () => {
      const input = '好的哦，我已经处理完了呢';
      const result = personaRules.adjustTone(input, 'development');
      expect(result.adjustedContent).not.toContain('哦');
      expect(result.adjustedContent).not.toContain('呢');
    });
  });
});
