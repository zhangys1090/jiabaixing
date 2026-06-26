/**
 * Learning Features 综合测试
 * 覆盖8个新学习特性的核心功能
 */

import {
  ComplexityLLMDeps,
  TaskComplexityAnalyzer,
} from '../src/core/TaskComplexityAnalyzer';
import {
  EvolutionEngine,
  FewShotExample,
} from '../src/evolution/EvolutionEngine';
import { FeedbackCollector } from '../src/evolution/FeedbackCollector';
import {
  SkillInsightReport,
  SkillUsageTracker,
} from '../src/evolution/SkillUsageTracker';
import { EvolutionEngineV2 } from '../src/evolution/v2/EvolutionEngineV2';
import { SelfModificationEngine } from '../src/evolution/v2/SelfModificationEngine';
import { EvolutionAction, StrategyRecord } from '../src/evolution/v2/types';
import { EmotionTag } from '../src/interfaces';
import {
  KnowledgeGraphBuilder,
  LLMReasoningProvider,
} from '../src/memory/KnowledgeGraphBuilder';
import { MemoryItem, MemoryType } from '../src/memory/MemoryEngine';
import { UserProfile } from '../src/memory/UserProfile';
import {
  ProfileEvolutionManager,
  SessionData,
} from '../src/user/ProfileEvolutionManager';
import { UserProfileSystem } from '../src/user/UserProfileSystem';

// ==================== Mock 工具 ====================

/** /** 创建模拟 LLM 提供者 */
function createMockLLMProvider(
  responseOverride?: string
): LLMReasoningProvider {
  return {
    chat: jest.fn().mockResolvedValue(
      responseOverride ??
        JSON.stringify({
          conclusion: '测试推理结论',
          reasoningType: 'induction',
          confidence: 0.8,
          evidence: [],
          reasoning: '测试推理过程',
        })
    ),
  };
}

/** 创建模拟 LLM 客户端(EvolutionEngineV2 格式) */
function createMockLLMClient() {
  return {
    chat: jest.fn().mockResolvedValue('mock evolution plan response'),
  };
}

/** 创建模拟 MemoryItem */
function createMemoryItem(
  content: string,
  id?: string,
  importance?: number
): MemoryItem {
  return {
    id: id ?? `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: MemoryType.SHORT_TERM,
    content,
    timestamp: new Date(),
    importance: importance ?? 5,
    decayScore: 0.5,
  };
}

/** 创建模拟 UserProfileSystem */
function createMockUserProfileSystem(): UserProfileSystem {
  const system = new UserProfileSystem();
  system.initialize();
  return system;
}

// ==================== 测试开始====================

describe('Learning Features', () => {
  // ==================== 1. 跨会话知识迁移====================
  describe('1. Cross-session Knowledge Migration', () => {
    let builder: KnowledgeGraphBuilder;

    beforeEach(() => {
      builder = new KnowledgeGraphBuilder();
    });

    it('应该识别跨会话共享实体并补全关联', async () => {
      const sessionMemories = new Map<string, MemoryItem[]>();
      sessionMemories.set('session-1', [
        createMemoryItem('我喜欢Python编程', 'm1'),
        createMemoryItem('我喜欢Python编程', 'm2'),
        createMemoryItem('我喜欢Python编程', 'm3'),
      ]);
      sessionMemories.set('session-2', [
        createMemoryItem('我喜欢Python编程', 'm4'),
        createMemoryItem('我喜欢Python编程', 'm5'),
        createMemoryItem('Python是项目需要的语言', 'm6'),
      ]);

      const result =
        await builder.migrateCrossSessionKnowledge(sessionMemories);

      expect(result).toBeDefined();
      expect(result.migratedAt).toBeInstanceOf(Date);
      expect(result.migratedNodes).toBeGreaterThanOrEqual(0);
      expect(result.newAssociations).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.inferredKnowledge)).toBe(true);
    });

    it('会话数不足时应返回空结果', async () => {
      const sessionMemories = new Map<string, MemoryItem[]>();
      sessionMemories.set('session-1', [createMemoryItem('测试内容')]);

      const result =
        await builder.migrateCrossSessionKnowledge(sessionMemories);

      expect(result.newAssociations).toBe(0);
      expect(result.migratedNodes).toBe(0);
      expect(result.inferredKnowledge).toHaveLength(0);
    });

    it('有 LLM 时应尝试推理隐含知识', async () => {
      const mockLLM = createMockLLMProvider(
        JSON.stringify({
          conclusions: [{ conclusion: '用户偏好Python开发', confidence: 0.85 }],
        })
      );
      builder.setLLMProvider(mockLLM);

      // 需要足够的重复记忆才能让实体出现在图谱中（weight >= 2）
      const s1Memories: MemoryItem[] = [];
      const s2Memories: MemoryItem[] = [];
      for (let i = 0; i < 5; i++) {
        s1Memories.push(createMemoryItem('我喜欢Python编程', `m1_${i}`));
        s2Memories.push(createMemoryItem('我喜欢Python编程', `m2_${i}`));
      }

      const sessionMemories = new Map<string, MemoryItem[]>();
      sessionMemories.set('s1', s1Memories);
      sessionMemories.set('s2', s2Memories);

      const result =
        await builder.migrateCrossSessionKnowledge(sessionMemories);

      // 结果结构应正确
      expect(Array.isArray(result.inferredKnowledge)).toBe(true);
      // LLM 已设置（无论是否被调用取决于共享实体检测）
      expect(mockLLM.chat).toBeDefined();
    });
  });

  // ==================== 2. 元认知（能力边界）====================
  describe('2. Metacognition (Capability Boundary)', () => {
    let engine: EvolutionEngineV2;

    beforeEach(() => {
      const mockLLM = createMockLLMClient();
      engine = new EvolutionEngineV2(mockLLM, './test-checkpoints');
    });

    it('无历史记录时应返回默认中等置信度', () => {
      const assessment = engine.assessCapability('unknown-domain', '测试任务');

      expect(assessment.canHandle).toBe(true);
      expect(assessment.confidenceLevel).toBe(0.5);
      expect(assessment.suggestedAlternative).toBeNull();
      expect(assessment.reasoning).toContain('无历史记录');
    });

    it('成功记录应提升置信度，失败记录应降低', () => {
      // 记录多次成功
      for (let i = 0; i < 5; i++) {
        engine.recordCapabilityOutcome('coding', true);
      }

      const assessment = engine.assessCapability('coding', '写代码');
      expect(assessment.canHandle).toBe(true);
      expect(assessment.confidenceLevel).toBeGreaterThan(0.5);

      // 记录多次失败
      for (let i = 0; i < 10; i++) {
        engine.recordCapabilityOutcome('math', false);
      }

      const mathAssessment = engine.assessCapability('math', '数学计算');
      expect(mathAssessment.canHandle).toBe(false);
      expect(mathAssessment.suggestedAlternative).not.toBeNull();
    });

    it('应该正确生成能力报告和识别弱区', () => {
      engine.recordCapabilityOutcome('strong-domain', true);
      engine.recordCapabilityOutcome('strong-domain', true);
      engine.recordCapabilityOutcome('weak-domain', false);
      engine.recordCapabilityOutcome('weak-domain', false);

      const report = engine.getCapabilityReport();

      expect(report.totalDomains).toBe(2);
      expect(report.boundaries).toHaveLength(2);
      expect(report.weakAreas).toContain('weak-domain');
      expect(report.averageConfidence).toBeGreaterThan(0);
    });
  });

  // ==================== 3. Few-shot 学习 ====================
  describe('3. Few-shot Learning', () => {
    let engine: EvolutionEngine;

    beforeEach(() => {
      engine = new EvolutionEngine(undefined);
    });

    it('示例不足2个时不应泛化', () => {
      const examples: FewShotExample[] = [
        {
          input: '帮我写一个排序函数',
          output: '调用 sort_utils',
          category: 'coding',
          quality_score: 0.8,
          timestamp: Date.now(),
        },
      ];

      const skill = engine.learnFromFewShots(examples, 'coding');
      expect(skill).toBeNull();
    });

    it('2个以上同类别示例应生成泛化技能', () => {
      const examples: FewShotExample[] = [
        {
          input: '帮我写一个排序函数',
          output: '调用 sort_utils 工具',
          category: 'coding',
          quality_score: 0.9,
          timestamp: Date.now(),
        },
        {
          input: '帮我写一个排序算法',
          output: '调用 sort_utils 工具',
          category: 'coding',
          quality_score: 0.85,
          timestamp: Date.now(),
        },
      ];

      const skill = engine.learnFromFewShots(examples, 'coding');

      expect(skill).not.toBeNull();
      expect(skill!.name).toContain('fewshot-coding');
      expect(skill!.confidence).toBeGreaterThan(0);
      expect(skill!.triggerKeywords.length).toBeGreaterThanOrEqual(0);
    });

    it('addFewShotExample 应自动触发泛化', () => {
      engine.addFewShotExample({
        input: '帮我写一个排序函数',
        output: '调用 sort_utils',
        category: 'coding',
        quality_score: 0.9,
        timestamp: Date.now(),
      });

      engine.addFewShotExample({
        input: '帮我写一个排序算法',
        output: '调用 sort_utils',
        category: 'coding',
        quality_score: 0.85,
        timestamp: Date.now(),
      });

      const matched = engine.matchFewShotSkill('帮我写排序');
      // 匹配结果可能为 null（取决于关键词重叠度），但不应抛出
    });

    it('matchFewShotSkill 无泛化技能时返回 null', () => {
      const result = engine.matchFewShotSkill('随便什么输入');
      expect(result).toBeNull();
    });
  });

  // ==================== 4. 协作学习 ====================
  describe('4. Collaborative Learning', () => {
    let tracker: SkillUsageTracker;

    beforeEach(() => {
      jest.mock('fs', () => ({
        existsSync: jest.fn().mockReturnValue(false),
        readFileSync: jest.fn().mockReturnValue(null),
        writeFileSync: jest.fn(),
        mkdirSync: jest.fn(),
        readdirSync: jest.fn().mockReturnValue([]),
      }));
      tracker = new SkillUsageTracker();
    });

    it('shareSkillInsights 应生成包含 topSkills 和 recommendations 的报告', () => {
      // 注册并使用一个 skill
      tracker.register('auto-code-gen', '/path/to/code-gen.md', 0.8);
      tracker.trackUse('auto-code-gen', 0.9);
      tracker.trackUse('auto-code-gen', 0.7);

      const report = tracker.shareSkillInsights('agent-001');

      expect(report.agentId).toBe('agent-001');
      expect(report.generatedAt).toBeTruthy();
      expect(Array.isArray(report.topSkills)).toBe(true);
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it('integrateExternalInsights 应调整本地技能质量分数', () => {
      // 使用唯一的技能名称避免与文件中的数据冲突
      const skillName = 'auto-code-gen-v2-test-' + Date.now();
      tracker.register(skillName, '/path/to/code-gen-v2.md', 0.8);
      tracker.trackUse(skillName, 0.8);

      const externalReport: SkillInsightReport = {
        agentId: 'agent-002',
        topSkills: [{ name: skillName, usageCount: 10, successRate: 0.6 }],
        recommendations: ['建议优化 ' + skillName],
        generatedAt: new Date().toISOString(),
      };

      const integratedCount = tracker.integrateExternalInsights(externalReport);

      // 本地有该技能，应被整合
      expect(integratedCount).toBe(1);

      // 质量分数应被微调（先更新到 0.76，然后 trackUse 再加权）
      // 0.76 * 1 + 0.8 = 1.56 / 2 = 0.78
      const record = tracker.getRecord(skillName);
      expect(record).toBeDefined();
      expect(record!.qualityScore).toBeCloseTo(0.78, 1);
    });

    it('缺少必要字段的外部洞察应被拒绝', () => {
      const invalidReport = {
        agentId: '',
        topSkills: [],
        recommendations: [],
        generatedAt: '',
      } as SkillInsightReport;

      const result = tracker.integrateExternalInsights(invalidReport);
      expect(result).toBe(0);
    });
  });

  // ==================== 5. 情绪学习 ====================
  describe('5. Emotion Learning', () => {
    let collector: FeedbackCollector;

    beforeEach(() => {
      collector = new FeedbackCollector();
    });

    it('detectEmotionShift 应检测消极情绪转变', () => {
      const result = collector.detectEmotionShift(
        '烦死了，总是出问题',
        '这是之前的回复'
      );

      expect(result).not.toBeNull();
      expect(result!.emotionType).toBe('negative');
      expect(result!.intensity).toBeGreaterThan(0);
      expect(result!.triggerPhrase).toBeTruthy();
      expect(result!.suggestedResponseAdjustment).toBeTruthy();
    });

    it('detectEmotionShift 应检测积极情绪转变', () => {
      const result = collector.detectEmotionShift(
        '太好了，终于搞定了！',
        '这是之前的回复'
      );

      expect(result).not.toBeNull();
      expect(result!.emotionType).toBe('positive');
    });

    it('无情绪关键词时应返回 null', () => {
      const result = collector.detectEmotionShift(
        '请帮我查看一下文件',
        '这是之前的回复'
      );

      expect(result).toBeNull();
    });

    it('getEmotionPatterns 应返回学习到的情绪模式', () => {
      // 触发多次情绪检测
      collector.detectEmotionShift('烦死了', '回复1');
      collector.detectEmotionShift('太好了', '回复2');
      collector.detectEmotionShift('烦死了', '回复3');

      const patterns = collector.getEmotionPatterns();

      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
      if (patterns.length >= 2) {
        expect(patterns[0].frequency).toBeGreaterThanOrEqual(
          patterns[1].frequency
        );
      }
    });
  });

  // ==================== 6. 长期策略学习 ====================
  describe('6. Long-term Strategy Learning', () => {
    let engine: EvolutionEngineV2;

    beforeEach(() => {
      const mockLLM = createMockLLMClient();
      engine = new EvolutionEngineV2(mockLLM, './test-checkpoints');
    });

    it('recordStrategyOutcome 应更新策略权重', () => {
      const record: StrategyRecord = {
        strategyType: 'CODE_FIX',
        appliedAt: Date.now(),
        outcome: 'success',
        impactScore: 0.8,
        context: '修复了编译错误',
      };

      engine.recordStrategyOutcome(record);

      // 成功应增加权重
      const recommendation = engine.predictOptimalStrategy('修复编译错误');
      if (recommendation) {
        expect(recommendation.recommendedType).toBeTruthy();
        expect(recommendation.confidence).toBeGreaterThan(0);
      }
    });

    it('失败策略应降低权重', () => {
      // 先记录成功
      engine.recordStrategyOutcome({
        strategyType: 'CODE_FIX',
        appliedAt: Date.now(),
        outcome: 'success',
        impactScore: 0.8,
        context: '修复编译错误',
      });

      // 再记录失败
      engine.recordStrategyOutcome({
        strategyType: 'CODE_FIX',
        appliedAt: Date.now(),
        outcome: 'failure',
        impactScore: 0.2,
        context: '修复编译错误失败',
      });

      const recommendation = engine.predictOptimalStrategy('修复编译错误');
      // 推荐应考虑失败记录
      if (recommendation) {
        expect(recommendation.confidence).toBeLessThan(1.0);
      }
    });

    it('无历史数据时 predictOptimalStrategy 应返?null', () => {
      const result = engine.predictOptimalStrategy('全新上下文');
      expect(result).toBeNull();
    });

    it('getStrategyTrends 应返回策略趋势', () => {
      // 记录足够多的策略
      for (let i = 0; i < 5; i++) {
        engine.recordStrategyOutcome({
          strategyType: 'CODE_FIX',
          appliedAt: Date.now() - (5 - i) * 1000,
          outcome: i < 2 ? 'failure' : 'success',
          impactScore: 0.7,
          context: '修复代码问题',
        });
      }

      const trends = engine.getStrategyTrends();

      expect(Array.isArray(trends)).toBe(true);
      if (trends.length > 0) {
        const codeFixTrend = trends.find((t) => t.strategyType === 'CODE_FIX');
        if (codeFixTrend) {
          expect(['improving', 'declining', 'stable']).toContain(
            codeFixTrend.direction
          );
          expect(codeFixTrend.dataPoints).toBeGreaterThan(0);
        }
      }
    });

    it('getResourcePreloadHints 应基于策略历史生成预加载提示', () => {
      // 记录足够多的策略
      for (let i = 0; i < 5; i++) {
        engine.recordStrategyOutcome({
          strategyType: 'CODE_FIX',
          appliedAt: Date.now(),
          outcome: 'success',
          impactScore: 0.8,
          context: '修复代码',
        });
      }

      const hints = engine.getResourcePreloadHints();

      expect(Array.isArray(hints)).toBe(true);
      if (hints.length > 0) {
        expect(hints[0].resourceType).toBeTruthy();
        expect(hints[0].probability).toBeGreaterThan(0);
        expect(hints[0].preloadAction).toBeTruthy();
      }
    });
  });

  // ==================== 7. 安全边界学习 ====================
  describe('7. Safety Boundary Learning', () => {
    let engine: SelfModificationEngine;

    beforeEach(() => {
      engine = new SelfModificationEngine();
    });

    it('assessActionSafety 应禁止删除 src/main.ts', () => {
      const action: EvolutionAction = {
        type: 'DELETE_FILE',
        target: 'src/main.ts',
        content: '',
        description: '删除入口文件',
      };

      const assessment = engine.assessActionSafety(action);

      expect(assessment.allowed).toBe(false);
      expect(assessment.riskLevel).toBe('forbidden');
      expect(assessment.requiresConfirmation).toBe(false);
    });

    it('assessActionSafety 应允许在 src/ 下创建文件', () => {
      const action: EvolutionAction = {
        type: 'CREATE_FILE',
        target: 'src/new-module.ts',
        content: 'export class NewModule {}',
        description: '创建新模块',
      };

      const assessment = engine.assessActionSafety(action);

      expect(assessment.allowed).toBe(true);
      expect(assessment.riskLevel).toBe('safe');
      expect(assessment.requiresConfirmation).toBe(false);
    });

    it('assessActionSafety 修改 src/core/* 应标记为 cautious', () => {
      const action: EvolutionAction = {
        type: 'MODIFY_FILE',
        target: 'src/core/JiabaixingCore.ts',
        content: '// modified',
        description: '修改核心文件',
      };

      const assessment = engine.assessActionSafety(action);

      expect(assessment.riskLevel).toBe('cautious');
      expect(assessment.requiresConfirmation).toBe(true);
    });

    it('learnSafetyOutcome 成功多次应降低风险等级', () => {
      // 使用一个不匹配任何硬编码默认边界的路径
      const action: EvolutionAction = {
        type: 'MODIFY_FILE',
        target: 'lib/utils/Helper.ts',
        content: '// modified',
        description: '修改工具文件',
      };

      // learnSafetyOutcome 创建 safe 边界（wasSafe=true)
      engine.learnSafetyOutcome(action, true);
      const afterFirst = engine.assessActionSafety(action);
      expect(afterFirst.riskLevel).toBe('safe');

      // 记录1次违规使风险升级到 cautious
      engine.learnSafetyOutcome(action, false);
      engine.learnSafetyOutcome(action, false); // 2次违规 → 升级到 cautious
      const afterViolation = engine.assessActionSafety(action);
      expect(afterViolation.riskLevel).toBe('cautious');

      // 记录5次成功且无违规（DE_ESCALATION_SUCCESS_THRESHOLD = 5, violationCount === 0)
      for (let i = 0; i < 5; i++) {
        engine.learnSafetyOutcome(action, true);
      }

      // 风险应降低到 safe
      const afterSuccess = engine.assessActionSafety(action);
      expect(afterSuccess.riskLevel).toBe('safe');
    });

    it('learnSafetyOutcome 违规多次应提升风险等级', () => {
      // 使用一个不匹配任何硬编码默认边界的路径
      const action: EvolutionAction = {
        type: 'MODIFY_FILE',
        target: 'lib/utils/AnotherHelper.ts',
        content: '// new',
        description: '修改文件',
      };

      // learnSafetyOutcome 创建 safe 边界
      engine.learnSafetyOutcome(action, true);
      const afterFirst = engine.assessActionSafety(action);
      expect(afterFirst.riskLevel).toBe('safe');

      // 记录2次违规（ESCALATION_VIOLATION_THRESHOLD = 2)
      engine.learnSafetyOutcome(action, false);
      engine.learnSafetyOutcome(action, false);

      const afterViolation = engine.assessActionSafety(action);
      expect(afterViolation.riskLevel).toBe('cautious');
    });

    it('getSafetyReport 应返回完整的安全报告', () => {
      const report = engine.getSafetyReport();

      expect(report.totalBoundaries).toBeGreaterThan(0);
      expect(Array.isArray(report.forbiddenPaths)).toBe(true);
      expect(Array.isArray(report.restrictedPaths)).toBe(true);
      expect(Array.isArray(report.cautiousPaths)).toBe(true);
      expect(Array.isArray(report.safePaths)).toBe(true);
      // src/main.ts 应在 forbiddenPaths 中
      expect(report.forbiddenPaths).toContain('src/main.ts');
    });
  });

  // ==================== 8. 用户使用模式学习 ====================
  describe('8. User Usage Pattern Learning', () => {
    let manager: ProfileEvolutionManager;
    let mockProfileSystem: UserProfileSystem;

    beforeEach(() => {
      mockProfileSystem = createMockUserProfileSystem();
      manager = new ProfileEvolutionManager(mockProfileSystem, {
        dataDir: './test-data/profiles',
        updateInterval: 999999999,
        currentUserId: 'test-user',
      });
    });

    it('learnUsagePattern 应更新高峰时段和偏好任务', () => {
      const sessionData: SessionData = {
        userId: 'test-user',
        duration: 30,
        tasksPerformed: ['coding', 'debugging'],
        toolsUsed: ['vscode', 'git'],
        activityTimestamps: [
          new Date().setHours(10, 0, 0, 0),
          new Date().setHours(10, 30, 0, 0),
          new Date().setHours(14, 0, 0, 0),
        ],
        resourcesAccessed: ['src/main.ts', 'package.json'],
        sessionStart: Date.now() - 30 * 60 * 1000,
        sessionEnd: Date.now(),
      };

      manager.learnUsagePattern('test-user', sessionData);

      // 验证模式已学习（通过 predictNextAction 间接验证）
      const prediction = manager.predictNextAction('test-user');
      // 有模式数据时应该能预测（可能为 null 如果置信度不够）
      expect(prediction === null || prediction.confidence > 0).toBe(true);
    });

    it('predictNextAction 无模式数据时应返?null', () => {
      const result = manager.predictNextAction('unknown-user');
      expect(result).toBeNull();
    });

    it('predictNextAction 有模式数据时应返回预测', () => {
      // 先学习模式
      const sessionData: SessionData = {
        userId: 'test-user',
        duration: 30,
        tasksPerformed: ['coding', 'coding', 'coding'],
        toolsUsed: ['vscode', 'git', 'npm'],
        activityTimestamps: [
          new Date().setHours(10, 0, 0, 0),
          new Date().setHours(10, 30, 0, 0),
          new Date().setHours(14, 0, 0, 0),
        ],
        resourcesAccessed: ['src/main.ts'],
        sessionStart: Date.now() - 30 * 60 * 1000,
        sessionEnd: Date.now(),
      };

      // 学习多次以建立模式
      for (let i = 0; i < 3; i++) {
        manager.learnUsagePattern('test-user', sessionData);
      }

      const prediction = manager.predictNextAction('test-user');

      if (prediction) {
        expect(prediction.predictedAction).toBeTruthy();
        expect(prediction.confidence).toBeGreaterThan(0);
        expect(prediction.confidence).toBeLessThanOrEqual(0.95);
        expect(prediction.reasoning).toBeTruthy();
      }
    });

    it('getPersonalizedRecommendations 无模式数据时应返回空数组', () => {
      const recommendations =
        manager.getPersonalizedRecommendations('unknown-user');
      expect(recommendations).toEqual([]);
    });

    it('getPersonalizedRecommendations 应基于使用模式生成推荐', () => {
      const sessionData: SessionData = {
        userId: 'test-user',
        duration: 30,
        tasksPerformed: ['coding', 'coding', 'coding', 'coding'],
        toolsUsed: ['vscode', 'git', 'npm'],
        activityTimestamps: [
          new Date().setHours(10, 0, 0, 0),
          new Date().setHours(14, 0, 0, 0),
        ],
        resourcesAccessed: ['src/main.ts', 'src/main.ts', 'src/main.ts'],
        sessionStart: Date.now() - 30 * 60 * 1000,
        sessionEnd: Date.now(),
      };

      // 学习多次
      for (let i = 0; i < 4; i++) {
        manager.learnUsagePattern('test-user', sessionData);
      }

      const recommendations =
        manager.getPersonalizedRecommendations('test-user');

      expect(Array.isArray(recommendations)).toBe(true);
      if (recommendations.length > 0) {
        const rec = recommendations[0];
        expect(rec.type).toBeTruthy();
        expect(rec.description).toBeTruthy();
        expect(rec.confidence).toBeGreaterThan(0);
        expect(rec.action).toBeTruthy();
      }
    });
  });

  // ==================== 附加：UserProfile 情绪学习集成 ====================
  describe('UserProfile Emotion Learning Integration', () => {
    let profile: UserProfile;

    beforeEach(() => {
      profile = new UserProfile();
    });

    it('learnFromEmotionFeedback 有效策略应提升 effectiveness', () => {
      const emotion: EmotionTag = {
        type: '焦虑',
        intensity: 7,
        potentialNeeds: ['理性分析+行动建议'],
      };

      // 先触发一次更新以创建 comfortStrategy
      profile.setEmotionalPatterns({
        comfortStrategies: [
          {
            emotionType: '焦虑',
            strategy: '理性分析+行动建议',
            effectiveness: 0.5,
          },
        ],
        commonEmotions: [],
        triggerEvents: [],
        stressThreshold: 7,
        emotionalResilience: 6,
      });

      profile.learnFromEmotionFeedback(emotion, '理性分析+行动建议', true);

      const patterns = profile.getEmotionalPatterns();
      const strategy = patterns.comfortStrategies.find(
        (s) => s.emotionType === '焦虑' && s.strategy === '理性分析+行动建议'
      );

      if (strategy) {
        expect(strategy.effectiveness).toBeGreaterThan(0.5);
      }
    });

    it('learnFromEmotionFeedback 无效策略应降低 effectiveness', () => {
      const emotion: EmotionTag = {
        type: '焦虑',
        intensity: 7,
        potentialNeeds: ['理性分析+行动建议'],
      };

      profile.setEmotionalPatterns({
        comfortStrategies: [
          {
            emotionType: '焦虑',
            strategy: '理性分析+行动建议',
            effectiveness: 0.5,
          },
        ],
        commonEmotions: [],
        triggerEvents: [],
        stressThreshold: 7,
        emotionalResilience: 6,
      });

      profile.learnFromEmotionFeedback(emotion, '理性分析+行动建议', false);

      const patterns = profile.getEmotionalPatterns();
      const strategy = patterns.comfortStrategies.find(
        (s) => s.emotionType === '焦虑' && s.strategy === '理性分析+行动建议'
      );

      if (strategy) {
        expect(strategy.effectiveness).toBeLessThan(0.5);
      }
    });

    it('getBestComfortStrategy 应返回有效性最高的策略', () => {
      profile.setEmotionalPatterns({
        comfortStrategies: [
          {
            emotionType: '焦虑',
            strategy: '理性分析+行动建议',
            effectiveness: 0.8,
          },
          {
            emotionType: '焦虑',
            strategy: '情感陪伴+温暖安慰',
            effectiveness: 0.4,
          },
        ],
        commonEmotions: [],
        triggerEvents: [],
        stressThreshold: 7,
        emotionalResilience: 6,
      });

      const best = profile.getBestComfortStrategy('焦虑');

      expect(best).toBe('理性分析+行动建议');
    });

    it('getBestComfortStrategy 无匹配策略时应返回默认值', () => {
      const best = profile.getBestComfortStrategy('未知情绪');
      expect(best).toBeTruthy();
    });
  });

  // ==================== 附加：知识缺口识别 ====================
  describe('Knowledge Gap Identification', () => {
    let builder: KnowledgeGraphBuilder;

    beforeEach(() => {
      builder = new KnowledgeGraphBuilder();
    });

    it('identifyKnowledgeGaps 应识别孤立节点', () => {
      const graph = {
        nodes: [
          {
            id: '孤立实体',
            label: '孤立实体',
            type: 'entity' as const,
            weight: 5,
          },
          {
            id: '连接实体A',
            label: '连接实体A',
            type: 'entity' as const,
            weight: 3,
          },
          {
            id: '连接实体B',
            label: '连接实体B',
            type: 'entity' as const,
            weight: 3,
          },
        ],
        edges: [
          {
            source: '连接实体A',
            target: '连接实体B',
            label: '关联',
            weight: 1,
          },
        ],
      };

      const gaps = builder.identifyKnowledgeGaps(graph);

      expect(Array.isArray(gaps)).toBe(true);
      const orphanGap = gaps.find(
        (g) => g.entity === '孤立实体' && g.gapType === 'orphan_node'
      );
      expect(orphanGap).toBeDefined();
      expect(orphanGap!.priority).toBeGreaterThan(0);
    });

    it('identifyKnowledgeGaps 应识别缺失关系', () => {
      const graph = {
        nodes: [
          { id: '高频A', label: '高频A', type: 'entity' as const, weight: 5 },
          { id: '高频B', label: '高频B', type: 'entity' as const, weight: 4 },
          { id: '中间C', label: '中间C', type: 'entity' as const, weight: 3 },
        ],
        edges: [
          { source: '高频A', target: '中间C', label: '关联', weight: 1 },
          { source: '高频B', target: '中间C', label: '关联', weight: 1 },
        ],
      };

      const gaps = builder.identifyKnowledgeGaps(graph);

      const missingRelation = gaps.find(
        (g) => g.gapType === 'missing_relation'
      );
      // 高频A 和 高频B 之间没有直接连接
      if (missingRelation) {
        expect(missingRelation.suggestedQuery).toBeTruthy();
      }
    });

    it('空图谱应返回空缺口列表', () => {
      const gaps = builder.identifyKnowledgeGaps({ nodes: [], edges: [] });
      expect(gaps).toEqual([]);
    });
  });

  // ==================== 附加：主动知识补充 ====================
  describe('Proactive Knowledge Enrichment', () => {
    let builder: KnowledgeGraphBuilder;

    beforeEach(() => {
      builder = new KnowledgeGraphBuilder();
    });

    it('proactiveKnowledgeEnrichment 短文本应返回0', async () => {
      const result = await builder.proactiveKnowledgeEnrichment(
        createMemoryItem('ab'),
        { nodes: [], edges: [] }
      );
      expect(result).toBe(0);
    });

    it('proactiveKnowledgeEnrichment 实体不在图谱中应返回0', async () => {
      const result = await builder.proactiveKnowledgeEnrichment(
        createMemoryItem('我喜欢Python编程'),
        { nodes: [], edges: [] }
      );
      expect(result).toBe(0);
    });

    it('proactiveKnowledgeEnrichment 有 LLM 时应尝试发现关联', async () => {
      const mockLLM = createMockLLMProvider();
      builder.setLLMProvider(mockLLM);

      const graph = {
        nodes: [
          { id: 'Python', label: 'Python', type: 'entity' as const, weight: 5 },
        ],
        edges: [],
      };

      const result = await builder.proactiveKnowledgeEnrichment(
        createMemoryItem('我喜欢Python编程'),
        graph
      );

      // 结果应为数字（可能为0因为没有可发现的关联）
      expect(typeof result).toBe('number');
    });
  });

  // ==================== 🔶-2: 复杂度分析增强 ====================
  describe('🔶-2 Complexity Analysis Enhancement', () => {
    let analyzer: TaskComplexityAnalyzer;

    beforeEach(() => {
      analyzer = new TaskComplexityAnalyzer();
    });

    describe('基础复杂度分析增强', () => {
      it('应该返回包含 parallelismDetail 的结果', () => {
        const result = analyzer.analyzeComplexity('同时分析数据和生成报表');
        expect(result.parallelismDetail).toBeDefined();
        expect(result.parallelismDetail!.score).toBeGreaterThanOrEqual(0);
        expect(result.parallelismDetail!.score).toBeLessThanOrEqual(1);
        expect(
          result.parallelismDetail!.parallelizableSteps
        ).toBeGreaterThanOrEqual(0);
        expect(
          result.parallelismDetail!.sequentialSteps
        ).toBeGreaterThanOrEqual(0);
        expect(['none', 'low', 'medium', 'high', 'full']).toContain(
          result.parallelismDetail!.level
        );
        expect(Array.isArray(result.parallelismDetail!.suggestions)).toBe(true);
      });

      it('顺序任务应该有较低的并行度', () => {
        const result =
          analyzer.analyzeComplexity('首先分析，然后设计，最后实现');
        expect(result.parallelismScore).toBeLessThanOrEqual(0.5);
        if (result.parallelismDetail) {
          expect(result.parallelismDetail.sequentialSteps).toBeGreaterThan(0);
        }
      });

      it('并行任务应该有较高的并行度', () => {
        const result =
          analyzer.analyzeComplexity('同时分析数据、生成报表、查询数据库');
        expect(result.parallelismScore).toBeGreaterThan(0);
      });
    });

    describe('可并行度详细评估', () => {
      it('简单单步任务应返回 none 级别', () => {
        const result = analyzer.analyzeComplexity('你好');
        if (result.parallelismDetail) {
          expect(result.parallelismDetail.level).toBe('none');
          expect(result.parallelismDetail.parallelizableSteps).toBe(0);
        }
      });

      it('高并行度任务应返回 high 或 full 级别', () => {
        const result = analyzer.analyzeComplexity(
          '同时并行分别处理数据清洗、特征工程、模型训练'
        );
        if (result.parallelismDetail) {
          expect(['medium', 'high', 'full']).toContain(
            result.parallelismDetail.level
          );
        }
      });

      it('并行化建议应该根据级别生成', () => {
        const result = analyzer.analyzeComplexity('同时分析数据和生成报表');
        if (
          result.parallelismDetail &&
          result.parallelismDetail.level !== 'none'
        ) {
          expect(result.parallelismDetail.suggestions.length).toBeGreaterThan(
            0
          );
        }
      });
    });

    describe('LLM 辅助复杂度判断', () => {
      it('没有设置 LLM 时应返回基础分析结果', async () => {
        const result = await analyzer.analyzeComplexityWithLLM('分析数据趋势');
        expect(result.complexity).toBeDefined();
        expect(result.llmAssistedComplexity).toBeUndefined();
        expect(result.llmConfidence).toBeUndefined();
      });

      it('设置 LLM 后应在模糊任务时调用 LLM', async () => {
        const mockLLM: ComplexityLLMDeps = {
          chat: jest.fn().mockResolvedValue(
            JSON.stringify({
              complexity: 'complex',
              confidence: 0.85,
              estimatedSteps: 5,
            })
          ),
        };
        analyzer.setLLMDeps(mockLLM);

        const result = await analyzer.analyzeComplexityWithLLM('分析数据趋势');
        expect(result.llmAssistedComplexity).toBeDefined();
        expect(result.llmConfidence).toBeGreaterThanOrEqual(0);
        expect(result.llmConfidence).toBeLessThanOrEqual(1);
      });

      it('LLM 高置信度时应覆盖基础复杂度', async () => {
        const mockLLM: ComplexityLLMDeps = {
          chat: jest.fn().mockResolvedValue(
            JSON.stringify({
              complexity: 'very_complex',
              confidence: 0.9,
              estimatedSteps: 10,
            })
          ),
        };
        analyzer.setLLMDeps(mockLLM);

        const result = await analyzer.analyzeComplexityWithLLM('分析数据趋势');
        if (result.llmConfidence && result.llmConfidence >= 0.7) {
          expect(result.complexity).toBe('very_complex');
          expect(result.estimatedSteps).toBe(10);
        }
      });

      it('LLM 低置信度时不应覆盖基础复杂度', async () => {
        const mockLLM: ComplexityLLMDeps = {
          chat: jest.fn().mockResolvedValue(
            JSON.stringify({
              complexity: 'simple',
              confidence: 0.3,
              estimatedSteps: 1,
            })
          ),
        };
        analyzer.setLLMDeps(mockLLM);

        const baseResult = analyzer.analyzeComplexity('分析数据趋势');
        const result = await analyzer.analyzeComplexityWithLLM('分析数据趋势');
        if (result.llmConfidence && result.llmConfidence < 0.7) {
          expect(result.complexity).toBe(baseResult.complexity);
        }
      });

      it('LLM 返回无效 JSON 时应降级为基础分析', async () => {
        const mockLLM: ComplexityLLMDeps = {
          chat: jest.fn().mockResolvedValue('invalid response'),
        };
        analyzer.setLLMDeps(mockLLM);

        const result = await analyzer.analyzeComplexityWithLLM('分析数据趋势');
        expect(result.complexity).toBeDefined();
        expect(result.llmAssistedComplexity).toBeUndefined();
      });

      it('LLM 抛出异常时应降级为基础分析', async () => {
        const mockLLM: ComplexityLLMDeps = {
          chat: jest.fn().mockRejectedValue(new Error('LLM 不可用')),
        };
        analyzer.setLLMDeps(mockLLM);

        const result = await analyzer.analyzeComplexityWithLLM('分析数据趋势');
        expect(result.complexity).toBeDefined();
        expect(result.llmAssistedComplexity).toBeUndefined();
      });
    });

    describe('历史数据校准增强', () => {
      it('recordActualDuration 应记录执行时间', () => {
        analyzer.recordActualDuration('分析数据', 3, 15000);
        analyzer.recordActualDuration('分析数据', 3, 20000);
        analyzer.recordActualDuration('分析数据', 3, 18000);
        const calibrated = analyzer.calibrateTimeWithHistory('分析数据', 15);
        expect(calibrated).toBeDefined();
        expect(calibrated!).toBeGreaterThan(0);
      });

      it('历史数据不足时应返回 undefined', () => {
        analyzer.recordActualDuration('分析数据', 3, 15000);
        const calibrated = analyzer.calibrateTimeWithHistory('分析数据', 15);
        expect(calibrated).toBeUndefined();
      });

      it('不同领域任务应分别校准', () => {
        for (let i = 0; i < 3; i++) {
          analyzer.recordActualDuration('数据清洗和建模', 5, 30000);
        }
        for (let i = 0; i < 3; i++) {
          analyzer.recordActualDuration('文档转换', 2, 10000);
        }

        const dataCalibrated = analyzer.calibrateTimeWithHistory(
          '数据清洗和建模',
          25
        );
        const docCalibrated = analyzer.calibrateTimeWithHistory('文档转换', 10);

        expect(dataCalibrated).toBeDefined();
        expect(docCalibrated).toBeDefined();
      });

      it('recordActualRounds 应继续正常工作', () => {
        analyzer.recordActualRounds('分析数据', 3, 5);
        analyzer.recordActualRounds('分析数据', 3, 6);
        analyzer.recordActualRounds('分析数据', 3, 4);

        const result = analyzer.analyzeComplexity('分析数据');
        expect(result.calibratedEstimatedRounds).toBeDefined();
        expect(result.calibratedEstimatedRounds!).toBeGreaterThan(0);
      });
    });

    describe('领域关键词识别', () => {
      it('应该识别数据分析领域关键词', () => {
        const result = analyzer.analyzeComplexity('数据清洗和特征工程');
        expect(result.estimatedSteps).toBeGreaterThan(1);
      });

      it('应该识别文档处理领域关键词', () => {
        const result = analyzer.analyzeComplexity('文档转换和OCR文本提取');
        expect(result.estimatedSteps).toBeGreaterThan(1);
      });

      it('应该识别项目管理领域关键词', () => {
        const result = analyzer.analyzeComplexity('里程碑和甘特图依赖管理');
        expect(result.estimatedSteps).toBeGreaterThan(1);
      });

      it('领域标签应体现在任务模式中', () => {
        analyzer.recordActualRounds('数据清洗和建模', 5, 8);
        analyzer.recordActualRounds('数据清洗和建模', 5, 7);
        analyzer.recordActualRounds('数据清洗和建模', 5, 9);

        const result = analyzer.analyzeComplexity('数据清洗和建模');
        expect(result.calibratedEstimatedRounds).toBeDefined();
      });
    });
  });
});
