/**
 * Phase 1 优化组件测试
 * 验证增强型意图识别器、高级推理引擎和自主规划器的功能
 * NOTE: 跳过 - 引用的模块已在v4.0重构中删除
 */

import { AdvancedReasoningEngine, Decision, DecisionContext } from '../core/AdvancedReasoningEngine';
import { AutonomousPlanner, Goal } from '../core/AutonomousPlanner';
import { EnhancedIntentRecognizer } from '../core/EnhancedIntentRecognizer';
import { Logger } from '../utils/Logger';

describe.skip('Phase 1 优化组件', () => {

async function testEnhancedIntentRecognizer() {
  Logger.info('=== 测试增强型意图识别器 ===', 'Phase1Test');

  const recognizer = new EnhancedIntentRecognizer(null, false);

  const testInputs = [
    '帮我写一个React组件',
    '打开Chrome浏览器',
    '搜索TypeScript的最新特性',
    '查看main.ts文件的内容',
    '这个函数有bug，帮我修复一下'
  ];

  for (const input of testInputs) {
    try {
      const result = await recognizer.recognize(input);
      Logger.info(
        `输入: "${input}" -> 意图: ${result.level1}/${result.level2}, 置信度: ${result.calibratedConfidence.toFixed(2)}, 歧义: ${result.ambiguityScore.toFixed(2)}`,
        'Phase1Test'
      );

      if (result.alternativeIntents && result.alternativeIntents.length > 0) {
        Logger.info(
          `  替代意图: ${result.alternativeIntents.map(a => `${a.intent.level2}(${a.probability.toFixed(2)})`).join(', ')}`,
          'Phase1Test'
        );
      }
    } catch (error) {
      Logger.error(
        `意图识别失败: ${(error as Error).message}`,
        'Phase1Test'
      );
    }
  }

  const stats = recognizer.getIntentStatistics();
  Logger.info(`意图统计: ${Object.keys(stats).length} 个意图类型`, 'Phase1Test');
}

async function testAdvancedReasoningEngine() {
  Logger.info('=== 测试高级决策推理引擎 ===', 'Phase1Test');

  const engine = new AdvancedReasoningEngine();

  const context: DecisionContext = {
    objectives: [
      {
        id: 'accuracy',
        name: '准确率',
        weight: 0.6,
        minimize: false,
        targetValue: 0.95
      },
      {
        id: 'speed',
        name: '速度',
        weight: 0.4,
        minimize: true,
        targetValue: 1.0
      }
    ],
    constraints: [],
    availableResources: [],
    timeHorizon: 3600,
    riskTolerance: 'medium'
  };

  const decisions: Decision[] = [
    {
      id: 'decision_1',
      action: '使用规则匹配',
      parameters: {},
      expectedOutcomes: [
        {
          objectiveId: 'accuracy',
          expectedValue: 0.85,
          probability: 0.9
        },
        {
          objectiveId: 'speed',
          expectedValue: 0.5,
          probability: 0.95
        }
      ],
      resourceRequirements: [],
      estimatedDuration: 100,
      confidence: 0.8
    },
    {
      id: 'decision_2',
      action: '使用LLM分析',
      parameters: {},
      expectedOutcomes: [
        {
          objectiveId: 'accuracy',
          expectedValue: 0.92,
          probability: 0.85
        },
        {
          objectiveId: 'speed',
          expectedValue: 2.0,
          probability: 0.9
        }
      ],
      resourceRequirements: [],
      estimatedDuration: 2000,
      confidence: 0.75
    }
  ];

  try {
    const result = await engine.multiObjectiveOptimization(context, decisions);
    Logger.info(
      `最优决策: ${result.decision.action}, 综合得分: ${result.multiObjectiveScore.toFixed(3)}, 约束满足: ${result.constraintSatisfaction.toFixed(3)}, 风险调整: ${result.riskAdjustedScore.toFixed(3)}`,
      'Phase1Test'
    );

    const uncertainty = await engine.quantifyUncertainty(result.decision);
    Logger.info(
      `不确定性: 熵=${uncertainty.entropy.toFixed(3)}, 风险等级=${uncertainty.riskLevel}, 信息缺口=${uncertainty.informationGap.length}`,
      'Phase1Test'
    );

    const explanation = await engine.explainDecision(result.decision, context, decisions.filter(d => d.id !== result.decision.id));
    Logger.info(
      `决策解释: ${explanation.reasoning.length}条推理, ${explanation.keyFactors.length}个关键因素`,
      'Phase1Test'
    );

  } catch (error) {
    Logger.error(
      `决策推理测试失败: ${(error as Error).message}`,
      'Phase1Test'
    );
  }
}

async function testAutonomousPlanner() {
  Logger.info('=== 测试自主任务规划器 ===', 'Phase1Test');

  const planner = new AutonomousPlanner();

  const goals: Goal[] = [
    {
      id: 'goal_1',
      description: '创建一个用户登录的React组件',
      priority: 1,
      constraints: [],
      successCriteria: ['组件可运行', '测试通过']
    },
    {
      id: 'goal_2',
      description: '首先分析现有代码结构，然后重构用户认证模块，最后编写测试用例并部署到测试环境',
      priority: 1,
      constraints: [],
      successCriteria: ['重构完成', '测试通过', '部署成功']
    }
  ];

  for (const goal of goals) {
    try {
      Logger.info(`规划目标: ${goal.description}`, 'Phase1Test');

      const plan = await planner.hierarchicalDecomposition(goal);

      Logger.info(
        `生成计划: ${plan.subTasks.length}个子任务, 预计时间: ${plan.totalEstimatedTime}秒, 风险等级: ${plan.riskLevel}`,
        'Phase1Test'
      );

      plan.subTasks.slice(0, 3).forEach((task, index) => {
        Logger.info(
          `  任务${index + 1}: ${task.name} (${task.skillName}), 依赖: ${task.dependencies.join(', ') || '无'}`,
          'Phase1Test'
        );
      });

      const riskReport = planner.generateRiskReport(plan);
      Logger.info(
        `风险评估: 总体风险=${riskReport.overallRisk}, 识别风险=${riskReport.risks.length}个`,
        'Phase1Test'
      );

      if (riskReport.risks.length > 0) {
        riskReport.risks.slice(0, 2).forEach(risk => {
          Logger.info(
            `  风险: ${risk.description} (概率: ${(risk.probability * 100).toFixed(0)}%, 影响: ${(risk.impact * 100).toFixed(0)}%)`,
            'Phase1Test'
          );
        });
      }

    } catch (error) {
      Logger.error(
        `任务规划失败: ${(error as Error).message}`,
        'Phase1Test'
      );
    }
  }

  const resources = planner.getResourcePool();
  Logger.info(`资源池: ${resources.size}种资源可用`, 'Phase1Test');
}

async function runPhase1Tests() {
  Logger.info('🚀 开始Phase 1优化组件测试', 'Phase1Test');

  try {
    await testEnhancedIntentRecognizer();
    Logger.info('✅ 增强型意图识别器测试完成', 'Phase1Test');
  } catch (error) {
    Logger.error('❌ 增强型意图识别器测试失败', 'Phase1Test');
  }

  try {
    await testAdvancedReasoningEngine();
    Logger.info('✅ 高级决策推理引擎测试完成', 'Phase1Test');
  } catch (error) {
    Logger.error('❌ 高级决策推理引擎测试失败', 'Phase1Test');
  }

  try {
    await testAutonomousPlanner();
    Logger.info('✅ 自主任务规划器测试完成', 'Phase1Test');
  } catch (error) {
    Logger.error('❌ 自主任务规划器测试失败', 'Phase1Test');
  }

  Logger.info('🎯 Phase 1优化组件测试全部完成', 'Phase1Test');
}

if (require.main === module) {
  runPhase1Tests().catch(error => {
    Logger.error(`测试执行失败: ${error.message}`, 'Phase1Test');
    process.exit(1);
  });
}

export { runPhase1Tests };
