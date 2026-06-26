/**
 * EvolutionEngine - 进化引擎 V1（反馈学习层）
 *
 * 【架构定位】
 * 双层进化体系中的 V1 - 反馈学习层（轻量、快速、低风险）
 *
 * 与 V2 的关系：
 * - V1（本文件）= 反馈学习层：从交互中优化参数和 Prompt，不修改代码
 * - V2 = 自我进化层：真正的代码级自我修改，有完整的规划→执行→回滚机制
 * - 两者配合形成"快速迭代 + 深度进化"的双层进化体系
 *
 * 【核心职责】
 * - 收集交互反馈（成功/失败、质量评分、工具使用等）
 * - 从低质量交互中提取 PromptExample（触发→纠正模式）
 * - 从工具调用统计中计算进化权重
 * - 生成策略优化建议
 * - 识别需要持久化的知识
 * - 从示例中泛化通用技能
 *
 * 【特点】
 * - 轻量：实时运行，性能开销小
 * - 快速：每次交互都能学习
 * - 低风险：只修改参数和提示词，不修改代码
 * - 即时生效：学习结果立即应用
 *
 * 【使用场景】
 * - 工具权重动态调整
 * - Prompt 示例积累
 * - 用户偏好学习
 * - 高频、小幅度的优化
 *
 * @deprecated 已迁移到 Python agent/evolution/engine.py。
 *
 * 废弃状态说明：
 * - 废弃版本：V5.0
 * - 迁移日期：2026-06-22
 * - 预计移除版本：V6.0（约 2026-09）
 * - 替代方案：使用 Python 后端（AGENT_BACKEND=python，默认）
 * - 回退方式：设置 AGENT_BACKEND=local 可继续使用 TS 本地实现（不推荐）
 * - 维护状态：仅安全修复，不再新增功能
 *
 * 注意：当 AGENT_BACKEND=python（默认）时，此文件不会被使用。
 *       仅当显式设置 AGENT_BACKEND=local 时才会使用此 TS 实现。
 */

import { Logger } from '../utils/Logger';
import { skillUsageTracker } from './SkillUsageTracker';
import type { OptimizationLog, PromptExample } from './StrategyOptimizer';

export interface EvolutionMetrics {
  totalFeedback: number;
  totalOptimizations: number;
  successfulOptimizations: number;
  failedOptimizations: number;
  weeklyOptimizationStats?: { successRate: number };
}

interface FeedbackRecord {
  input: string;
  response: string;
  success: boolean;
  toolsUsed: string[];
  timestamp: number;
  qualityScore?: number;
  scene?: string;
}

interface ToolStat {
  calls: number;
  successes: number;
  totalDuration: number;
}

/** Few-shot 示例 */
export interface FewShotExample {
  input: string;
  output: string;
  category: string;
  quality_score: number;
  timestamp: number;
}

/** 泛化技能 */
interface GeneralizedSkill {
  name: string;
  triggerKeywords: string[];
  exampleCount: number;
  avgQuality: number;
  category: string;
  createdAt: number;
}

const MAX_FEEDBACK_HISTORY = 500;
const MAX_PROMPT_EXAMPLES = 20;
const MIN_QUALITY_FOR_LEARNING = 0.6;
const SKILL_QUALITY_DECLINE_WINDOW = 3;
const KNOWLEDGE_PERSISTENCE_KEYWORDS = [
  '我喜欢',
  '我偏好',
  '记住',
  '以后都这样',
  '以后都',
  '每次都',
  '总是',
  '习惯',
  '偏好',
  '我习惯',
  '请记住',
  '务必',
  '一定要',
  '默认',
  '我的风格',
  '按照我',
  '我通常',
];

export class EvolutionEngine {
  private feedbackHistory: FeedbackRecord[] = [];
  private promptExamples: PromptExample[] = [];
  private toolStats: Map<string, ToolStat> = new Map();
  private optimizationCount = 0;
  private successfulOptimizations = 0;
  private persisted = false;
  private persistencePath: string;
  /** Few-shot 示例 */
  private fewShotExamples: FewShotExample[] = [];
  /** 泛化技能 */
  private generalizedSkills: GeneralizedSkill[] = [];

  constructor(_memoryEngine?: unknown) {
    this.persistencePath = require('path').join(
      process.cwd(),
      'data',
      'evolution',
      'engine-state.json'
    );
    this.loadState();
  }

  private skillDir: string = '';

  start(): void {}
  stop(): void {}

  /**
   * 从成功的高质量执行中生成 SKILL.md 文件
   * 让 agent 下次遇到同类任务时可以直接加载 skill
   */
  generateSkill(params: {
    input: string;
    response: string;
    toolsUsed: string[];
    totalDuration: number;
    qualityScore: number;
    traceId: string;
  }): string | null {
    // 只对高质量结果生成 skill
    if (params.qualityScore < 0.7) return null;
    if (!params.input || params.input.length < 5) return null;

    const skillName = this.skillNameFromInput(params.input);
    const skillPath = require('path').join(
      require('path').dirname(this.persistencePath),
      'skills',
      `${skillName}.md`
    );

    // 如果已存在同名 skill，跳过（避免覆盖）
    const fs = require('fs');
    if (fs.existsSync(skillPath)) {
      Logger.debug(`⏭️ Skill 已存在: ${skillName}`, 'EvolutionEngine');
      return skillPath;
    }

    const toolsFormatted = params.toolsUsed
      .map((t) => `  - \`${t}\``)
      .join('\n');

    const skillContent = `---
name: ${skillName}
description: 从交互中自动生成 — ${params.input.substring(0, 60)}
version: 1.0.0
source: evolution
license: MIT
compatibility: ">=5.0"
generatedAt: ${new Date().toISOString()}
agentskillsIo:
  version: "1.0.0"
  schema: "https://agentskills.io/schemas/skill-v1.json"
  hubId: ${skillName}-${Date.now()}
metadata:
  hermes:
    tags: [auto-generated, evolution]
---

# ${skillName}

自动生成的技能，源自一次成功的高质量交互。

## 触发条件

当用户输入涉及类似以下关键词时：

\`\`\`
${this.extractKeywords(params.input).join(', ')}
\`\`\`

## 执行步骤

原始输入: "${params.input.substring(0, 120)}"

### 使用的工具链

${toolsFormatted || '  无工具调用'}

### 质量评分

- 质量分数: ${(params.qualityScore * 100).toFixed(0)}%
- 耗时: ${(params.totalDuration / 1000).toFixed(1)}s
- 轨迹ID: ${params.traceId}

## 参考

原始响应摘要:

${params.response.substring(0, 300)}

---

_由 jiabaixing EvolutionEngine 于 ${new Date().toLocaleString('zh-CN')} 自动生成_
`;

    try {
      const dir = require('path').dirname(skillPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(skillPath, skillContent, 'utf-8');
      Logger.info(
        `📝 自动生成 Skill: ${skillName} → ${skillPath}`,
        'EvolutionEngine'
      );

      // 注册到使用追踪器
      skillUsageTracker.register(skillName, skillPath, params.qualityScore);

      return skillPath;
    } catch (err) {
      Logger.warn(
        `❌ Skill 生成失败: ${(err as Error).message}`,
        'EvolutionEngine'
      );
      return null;
    }
  }

  /**
   * 从用户输入中提取技能名称
   */
  private skillNameFromInput(input: string): string {
    const cleaned = input
      .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
      .trim()
      .substring(0, 30);
    const name = cleaned.replace(/\s+/g, '-').toLowerCase();
    return `auto-${name || 'unnamed'}`;
  }

  /**
   * 记录交互反馈 — 从每次交互中学习
   *
   * [OVERLAP] 此功能与 V2 中的进化触发机制有重叠
   * - V1（本方法）：主动收集每次交互的反馈，用于快速参数优化
   * - V2：被动触发，只在特定条件（如失败、低满意度）下触发深度进化
   * - 未来合并方向：保留 V1 的高频收集，V2 的深度分析由编排器协调
   */
  collectFeedback(
    input: string,
    response: string,
    result: {
      success: boolean;
      intent?: string;
      toolsUsed?: string[];
      error?: string;
    },
    scene?: string
  ): void {
    const record: FeedbackRecord = {
      input: input.substring(0, 500),
      response: response.substring(0, 500),
      success: result.success,
      toolsUsed: result.toolsUsed || [],
      timestamp: Date.now(),
      scene,
    };

    this.feedbackHistory.push(record);
    if (this.feedbackHistory.length > MAX_FEEDBACK_HISTORY) {
      this.feedbackHistory = this.feedbackHistory.slice(-MAX_FEEDBACK_HISTORY);
    }

    // 更新工具统计
    for (const toolName of record.toolsUsed) {
      const stat = this.toolStats.get(toolName) || {
        calls: 0,
        successes: 0,
        totalDuration: 0,
      };
      stat.calls++;
      if (result.success) stat.successes++;
      this.toolStats.set(toolName, stat);
    }

    // 从失败交互中提取学习模式
    if (!result.success && result.error) {
      this.extractLearningPattern(input, response, result.error, scene);
    }

    // 追踪 auto-generated skill 的使用情况
    this.trackSkillUsageFromFeedback(input, result.toolsUsed || []);

    // 检测 skill 质量下降并自动触发改进
    this.checkSkillQualityDecline(input);

    this.schedulePersist();
  }

  /**
   * 评估质量 — 记录质量分数用于学习，并更新对应 skill 的质量分数
   * @param _traceId - 轨迹ID
   * @param success - 是否成功
   * @param qualityScore - 质量评分 (0~1)
   * @param duration - 耗时(ms)
   * @param scene - 场景标识
   *
   * [OVERLAP] 此功能与 V2 中的质量触发机制有重叠
   * - V1（本方法）：详细的质量评估，用于策略优化和技能学习
   * - V2：简单的质量阈值判断，低于阈值时触发深度进化
   * - 未来合并方向：统一质量评估标准，由编排器根据质量等级决定触发 V1 还是 V2
   */
  assessQuality(
    _traceId: string,
    success: boolean,
    qualityScore: number,
    _duration: number,
    _scene?: string
  ): void {
    // 更新最近一条反馈的质量分数
    const last = this.feedbackHistory[this.feedbackHistory.length - 1];
    if (last) {
      last.qualityScore = qualityScore;

      // 更新匹配的 auto-generated skill 的质量分数
      this.updateMatchedSkillQuality(last.input, qualityScore);
    }

    // 低质量交互触发学习
    if (
      qualityScore < MIN_QUALITY_FOR_LEARNING &&
      this.feedbackHistory.length > 0
    ) {
      const recent = this.feedbackHistory.slice(-5);
      const pattern = this.findCommonPattern(recent);
      if (pattern) {
        this.addPromptExample(pattern);
      }
    }
  }

  /**
   * 从失败交互中提取学习模式
   */
  private extractLearningPattern(
    input: string,
    response: string,
    error: string,
    scene?: string
  ): void {
    // 提取触发关键词
    const triggerKeywords = this.extractKeywords(input);
    if (triggerKeywords.length === 0) return;

    // 生成纠正建议
    const correction = this.generateCorrection(input, error, scene);

    // 检查是否已有类似模式
    const existing = this.promptExamples.find(
      (e) =>
        this.calculateSimilarity(e.trigger, triggerKeywords.join(' ')) > 0.6
    );

    if (existing) {
      existing.frequency++;
      Logger.debug(
        `🧬 进化学习: 已有模式频率+1 (${existing.trigger.substring(0, 30)}...)`,
        'EvolutionEngine'
      );
    } else {
      this.addPromptExample({
        trigger: triggerKeywords.join(' '),
        correction,
        example: `用户说"${input.substring(0, 80)}"时，正确做法是: ${correction}`,
      });
    }
  }

  /**
   * 从交互记录中找到共同模式
   */
  private findCommonPattern(records: FeedbackRecord[]): {
    trigger: string;
    correction: string;
    example: string;
  } | null {
    const failed = records.filter(
      (r) => !r.success || (r.qualityScore && r.qualityScore < 0.5)
    );
    if (failed.length < 2) return null;

    // 找共同关键词
    const keywordCounts = new Map<string, number>();
    for (const record of failed) {
      const keywords = this.extractKeywords(record.input);
      for (const kw of keywords) {
        keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
      }
    }

    const commonKeywords = Array.from(keywordCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([kw]) => kw);

    if (commonKeywords.length === 0) return null;

    const commonTools = this.findCommonTools(failed);
    return {
      trigger: commonKeywords.join(' '),
      correction: `避免以下模式: ${commonTools.length > 0 ? '工具 ' + commonTools.join('/') + ' 调用失败' : '响应质量低'}`,
      example: `当用户提到 ${commonKeywords.join('/')} 时，需要更仔细地处理`,
    };
  }

  /**
   * 找到失败记录中共同使用的工具
   */
  private findCommonTools(records: FeedbackRecord[]): string[] {
    const toolCounts = new Map<string, number>();
    for (const record of records) {
      for (const tool of record.toolsUsed) {
        toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
      }
    }
    return Array.from(toolCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([tool]) => tool);
  }

  /**
   * 添加 PromptExample
   */
  private addPromptExample(example: {
    trigger: string;
    correction: string;
    example: string;
  }): void {
    this.promptExamples.push({
      ...example,
      frequency: 1,
    });

    // 保留高频示例
    if (this.promptExamples.length > MAX_PROMPT_EXAMPLES) {
      this.promptExamples.sort((a, b) => b.frequency - a.frequency);
      this.promptExamples = this.promptExamples.slice(0, MAX_PROMPT_EXAMPLES);
    }

    this.optimizationCount++;
    this.successfulOptimizations++;

    Logger.info(
      `🧬 进化学习: 新增纠错示例 "${example.trigger.substring(0, 30)}..." → "${example.correction.substring(0, 50)}..."`,
      'EvolutionEngine'
    );

    this.schedulePersist();
  }

  /**
   * 生成纠正建议
   */
  private generateCorrection(
    input: string,
    error: string,
    scene?: string
  ): string {
    if (error.includes('timeout') || error.includes('超时')) {
      return '操作超时，请简化请求或分步执行';
    }
    if (error.includes('permission') || error.includes('权限')) {
      return '权限不足，请检查文件路径或使用安全的操作方式';
    }
    if (error.includes('not found') || error.includes('未找到')) {
      return '资源不存在，请先确认文件/路径是否正确';
    }
    if (scene === 'coding') {
      return '代码相关请求需要更精确的文件路径和上下文';
    }
    return '请提供更明确的指令，避免歧义';
  }

  /**
   * 提取关键词
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      '的',
      '了',
      '是',
      '在',
      '我',
      '你',
      '他',
      '她',
      '它',
      '们',
      '这',
      '那',
      '有',
      '不',
      '就',
      '也',
      '都',
      '而',
      '及',
      '与',
      '或',
      '请',
      '帮',
      '能',
      '可以',
      '怎么',
      '什么',
      '如何',
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'shall',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'i',
      'me',
      'my',
      'we',
      'our',
      'you',
      'your',
      'he',
      'him',
      'his',
      'she',
      'her',
      'it',
      'its',
      'they',
      'them',
      'their',
    ]);

    const words = text.split(/[\s,，。.!！?？;；:：、\n]+/);
    const keywords: string[] = [];

    for (const word of words) {
      const trimmed = word.trim().toLowerCase();
      if (trimmed.length >= 2 && !stopWords.has(trimmed)) {
        keywords.push(trimmed);
      }
    }

    return [...new Set(keywords)].slice(0, 5);
  }

  /**
   * 计算文本相似度（简单 Jaccard）
   */
  private calculateSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 获取策略优化器 — 真实实现
   *
   * [OVERLAP] 此功能与 V2 中的策略学习（strategyRecords/strategyWeights）高度重叠
   * - V1（本方法）：StrategyOptimizer 类，负责策略优化，生成优化日志
   * - V2：strategyRecords 和 strategyWeights 属性，负责策略记录和权重调整
   * - 未来合并方向：统一策略学习框架，提取共享的策略管理模块
   */
  getStrategyOptimizer(): {
    getPromptExamples(): PromptExample[];
  } {
    return {
      getPromptExamples: () => [...this.promptExamples],
    };
  }

  /**
   * 获取工具进化权重 — 从工具统计中计算
   * 权重范围: 0.5 (失败率高) ~ 1.5 (成功率高)
   */
  getToolWeights(): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const [toolName, stat] of this.toolStats) {
      if (stat.calls >= 3) {
        const successRate = stat.successes / stat.calls;
        // 线性映射: 0%成功率→0.5权重, 100%成功率→1.5权重
        weights[toolName] = 0.5 + successRate;
      }
    }
    return weights;
  }

  /**
   * 手动触发优化
   */
  triggerManualOptimization(_reason: string): OptimizationLog | null {
    if (this.promptExamples.length === 0) return null;

    this.optimizationCount++;
    this.successfulOptimizations++;

    return {
      id: `opt_${Date.now()}`,
      timestamp: new Date(),
      reason: _reason,
      toneAdjustments: [],
      skillAdjustments: [],
      promptExamples: [...this.promptExamples],
      success: true,
      description: `手动优化: ${this.promptExamples.length} 个纠错示例已应用`,
    };
  }

  /**
   * 获取进化洞察
   */
  getInsights(): Array<{
    type: string;
    description: string;
    confidence: number;
  }> {
    const insights: Array<{
      type: string;
      description: string;
      confidence: number;
    }> = [];

    if (this.promptExamples.length > 0) {
      insights.push({
        type: 'prompt_optimization',
        description: `已学习 ${this.promptExamples.length} 个纠错模式`,
        confidence: 0.8,
      });
    }

    const unreliableTools = Array.from(this.toolStats.entries())
      .filter(
        ([, stat]) => stat.calls >= 3 && stat.successes / stat.calls < 0.5
      )
      .map(([name]) => name);

    if (unreliableTools.length > 0) {
      insights.push({
        type: 'tool_reliability',
        description: `以下工具成功率偏低: ${unreliableTools.join(', ')}`,
        confidence: 0.9,
      });
    }

    return insights;
  }

  /**
   * 自动改进已生成的 skill — 当检测到 skill 质量持续下降时调用
   * 读取现有 skill 文件，结合最近的失败模式，重写 skill 内容
   * @param skillName - 需要改进的 skill 名称
   * @returns 改进是否成功
   */
  improveAutoSkill(skillName: string): boolean {
    const record = skillUsageTracker.getRecord(skillName);
    if (!record) {
      Logger.warn(
        `improveAutoSkill: skill 未注册 ${skillName}`,
        'EvolutionEngine'
      );
      return false;
    }

    const fs = require('fs');
    const skillPath = record.path;

    if (!fs.existsSync(skillPath)) {
      Logger.warn(
        `improveAutoSkill: skill 文件不存在 ${skillPath}`,
        'EvolutionEngine'
      );
      return false;
    }

    try {
      const originalContent = fs.readFileSync(skillPath, 'utf-8');

      // 收集与该 skill 相关的最近失败模式
      const relatedFailures = this.collectRelatedFailures(skillName);
      const failurePatterns = relatedFailures
        .map((f) => `- 输入: "${f.input.substring(0, 80)}" → 错误: ${f.error}`)
        .join('\n');

      // 收集相关的纠错示例
      const relatedCorrections = this.promptExamples
        .filter((e) => {
          const skillKeywords = skillName.replace(/^auto-/, '').split('-');
          return skillKeywords.some((kw) => e.trigger.includes(kw));
        })
        .map((e) => `- 触发: "${e.trigger}" → 纠正: ${e.correction}`)
        .join('\n');

      // 解析原始版本号并递增
      const versionMatch = originalContent.match(
        /version:\s*(\d+)\.(\d+)\.(\d+)/
      );
      const major = versionMatch ? parseInt(versionMatch[1], 10) : 1;
      const minor = versionMatch ? parseInt(versionMatch[2], 10) + 1 : 1;
      const patch = versionMatch ? parseInt(versionMatch[3], 10) : 0;
      const newVersion = `${major}.${minor}.${patch}`;

      // 构建改进后的 skill 内容
      const improvedContent = originalContent
        .replace(/version:\s*\d+\.\d+\.\d+/, `version: ${newVersion}`)
        .replace(
          /---\n/,
          `---\n\n<!-- 自动改进记录 -->\n<!-- 改进时间: ${new Date().toISOString()} -->\n<!-- 改进原因: 质量评分持续下降 -->\n`
        );

      // 在 skill 末尾追加改进内容
      const improvementSection = `

## 自动改进记录 (${newVersion})

_改进时间: ${new Date().toLocaleString('zh-CN')}_

### 改进原因

最近 ${SKILL_QUALITY_DECLINE_WINDOW} 次使用的质量评分持续下降，当前平均质量: ${(record.qualityScore * 100).toFixed(0)}%

### 已识别的失败模式

${failurePatterns || '暂无具体失败记录'}

### 纠正建议

${relatedCorrections || '暂无纠错示例'}

### 改进指引

- 优先参考上述纠正建议调整执行步骤
- 对失败模式中提到的场景增加额外检查
- 如果工具调用失败率高，考虑使用替代工具或分步执行

---

_由 jiabaixing EvolutionEngine 于 ${new Date().toLocaleString('zh-CN')} 自动改进_
`;

      const finalContent = improvedContent + improvementSection;

      fs.writeFileSync(skillPath, finalContent, 'utf-8');

      Logger.info(
        `🔧 自动改进 Skill: ${skillName} → v${newVersion} (质量: ${(record.qualityScore * 100).toFixed(0)}%)`,
        'EvolutionEngine'
      );

      return true;
    } catch (err) {
      Logger.error(
        `improveAutoSkill 失败: ${(err as Error).message}`,
        err as Error,
        'EvolutionEngine'
      );
      return false;
    }
  }

  /**
   * 知识持久化提醒 — 当检测到用户表达了偏好、习惯或重要信息，但没有被存储到记忆时
   * 返回一个提醒字符串，供 LoopController 在 after_response 钩子中使用
   * @param input - 用户输入文本
   * @param toolsUsed - 本次交互使用的工具列表
   * @returns 提醒字符串，无需提醒时返回 null
   */
  nudgeKnowledgePersistence(input: string, toolsUsed: string[]): string | null {
    // 检测用户是否表达了偏好/习惯/重要信息
    const matchedKeyword = KNOWLEDGE_PERSISTENCE_KEYWORDS.find((kw) =>
      input.includes(kw)
    );
    if (!matchedKeyword) return null;

    // 检测是否已经通过 memory_store 工具存储
    const hasMemoryStore = toolsUsed.some(
      (tool) =>
        tool.includes('memory_store') ||
        tool.includes('memoryStore') ||
        tool.includes('save_memory')
    );
    if (hasMemoryStore) return null;

    // 提取用户表达的偏好内容摘要
    const preferenceSnippet = input.substring(0, 80);

    const nudge =
      `💡 检测到用户表达了偏好/习惯（关键词: "${matchedKeyword}"），但未调用记忆存储工具。` +
      `建议将以下信息持久化: "${preferenceSnippet}"`;

    Logger.info(
      `🧠 知识持久化提醒: 用户表达了偏好 "${matchedKeyword}"，但未存储`,
      'EvolutionEngine'
    );

    return nudge;
  }

  /**
   * 从反馈中追踪 auto-generated skill 的使用情况
   * 当工具调用链匹配某个 skill 的触发关键词时，自动调用 skillUsageTracker.trackUse()
   * @param input - 用户输入
   * @param toolsUsed - 使用的工具列表
   */
  private trackSkillUsageFromFeedback(
    input: string,
    toolsUsed: string[]
  ): void {
    if (toolsUsed.length === 0) return;

    const inputKeywords = this.extractKeywords(input);
    if (inputKeywords.length === 0) return;

    // 检查所有已注册的 auto-generated skill
    const autoSkillNames = skillUsageTracker.getAutoGeneratedSkillNames();
    for (const skillName of autoSkillNames) {
      const skillKeywords = skillName
        .replace(/^auto-/, '')
        .split('-')
        .filter((k) => k.length >= 2);
      // 检查输入关键词是否与 skill 触发关键词有交集
      const hasOverlap = skillKeywords.some((sk) =>
        inputKeywords.some((ik) => ik.includes(sk) || sk.includes(ik))
      );
      if (hasOverlap) {
        skillUsageTracker.trackUse(skillName);
        Logger.debug(
          `📊 Skill 使用追踪: ${skillName} 匹配输入关键词 [${inputKeywords.join(', ')}]`,
          'EvolutionEngine'
        );
      }
    }
  }

  /**
   * 检测 skill 质量下降 — 当最近 N 次使用质量持续下降时自动触发改进
   * @param input - 用户输入（用于匹配 skill）
   */
  private checkSkillQualityDecline(input: string): void {
    const inputKeywords = this.extractKeywords(input);
    if (inputKeywords.length === 0) return;

    const autoSkillNames = skillUsageTracker.getAutoGeneratedSkillNames();
    for (const skillName of autoSkillNames) {
      const recentScores = skillUsageTracker.getRecentQualityScores(skillName);

      // 需要至少 SKILL_QUALITY_DECLINE_WINDOW 条记录才能判断趋势
      if (recentScores.length < SKILL_QUALITY_DECLINE_WINDOW) continue;

      // 检查最近 N 次是否持续下降
      const lastN = recentScores.slice(-SKILL_QUALITY_DECLINE_WINDOW);
      let isDeclining = true;
      for (let i = 1; i < lastN.length; i++) {
        if (lastN[i] >= lastN[i - 1]) {
          isDeclining = false;
          break;
        }
      }

      if (isDeclining) {
        Logger.info(
          `📉 检测到 Skill 质量下降: ${skillName} (最近${SKILL_QUALITY_DECLINE_WINDOW}次: [${lastN.map((s) => (s * 100).toFixed(0) + '%').join(' → ')}])`,
          'EvolutionEngine'
        );
        this.improveAutoSkill(skillName);
      }
    }
  }

  /**
   * 更新匹配的 auto-generated skill 的质量分数
   * @param input - 用户输入
   * @param qualityScore - 质量评分
   */
  private updateMatchedSkillQuality(input: string, qualityScore: number): void {
    const inputKeywords = this.extractKeywords(input);
    if (inputKeywords.length === 0) return;

    const autoSkillNames = skillUsageTracker.getAutoGeneratedSkillNames();
    for (const skillName of autoSkillNames) {
      const skillKeywords = skillName
        .replace(/^auto-/, '')
        .split('-')
        .filter((k) => k.length >= 2);
      const hasOverlap = skillKeywords.some((sk) =>
        inputKeywords.some((ik) => ik.includes(sk) || sk.includes(ik))
      );
      if (hasOverlap) {
        skillUsageTracker.trackUse(skillName, qualityScore);
        Logger.debug(
          `📊 Skill 质量更新: ${skillName} ← ${(qualityScore * 100).toFixed(0)}%`,
          'EvolutionEngine'
        );
      }
    }
  }

  /**
   * 收集与指定 skill 相关的最近失败记录
   * @param skillName - skill 名称
   * @returns 相关失败记录数组
   */
  private collectRelatedFailures(
    skillName: string
  ): Array<{ input: string; error: string }> {
    const skillKeywords = skillName
      .replace(/^auto-/, '')
      .split('-')
      .filter((k) => k.length >= 2);
    const failures: Array<{ input: string; error: string }> = [];

    // 从最近反馈中查找与该 skill 相关的失败记录
    const recentFeedback = this.feedbackHistory.slice(-50);
    for (const record of recentFeedback) {
      if (record.success) continue;
      const recordKeywords = this.extractKeywords(record.input);
      const isRelated = skillKeywords.some((sk) =>
        recordKeywords.some((rk) => rk.includes(sk) || sk.includes(rk))
      );
      if (isRelated) {
        failures.push({
          input: record.input,
          error: '质量评分低',
        });
      }
    }

    return failures.slice(-5);
  }

  /**
   * 获取指标
   *
   * [OVERLAP] 此功能与 V2 中的 EvolutionMetrics 高度重叠
   * - V1（本方法）：EvolutionMetrics 接口，包含反馈数、优化数、成功率等
   * - V2：EvolutionMetrics 接口（同名但定义不同），包含进化数、成功率、平均耗时、回滚率等
   * - 未来合并方向：统一指标格式，设计包含 V1+V2 所有指标的统一接口
   */
  getMetrics(): EvolutionMetrics {
    return {
      totalFeedback: this.feedbackHistory.length,
      totalOptimizations: this.optimizationCount,
      successfulOptimizations: this.successfulOptimizations,
      failedOptimizations:
        this.optimizationCount - this.successfulOptimizations,
    };
  }

  /**
   * 获取反馈历史（用于调试）
   */
  getFeedbackHistory(): FeedbackRecord[] {
    return [...this.feedbackHistory];
  }

  /**
   * 持久化状态
   */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistState();
    }, 5000);
  }

  private persistState(): void {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const state = {
        promptExamples: this.promptExamples,
        toolStats: Object.fromEntries(this.toolStats),
        feedbackHistory: this.feedbackHistory.slice(-100), // 只持久化最近100条
        optimizationCount: this.optimizationCount,
        successfulOptimizations: this.successfulOptimizations,
      };
      fs.writeFileSync(
        this.persistencePath,
        JSON.stringify(state, null, 2),
        'utf-8'
      );
      this.persisted = true;
    } catch (err) {
      Logger.warn(
        `进化引擎状态持久化失败: ${(err as Error).message}`,
        'EvolutionEngine'
      );
    }
  }

  private loadState(): void {
    try {
      const fs = require('fs');
      if (!fs.existsSync(this.persistencePath)) return;
      const raw = fs.readFileSync(this.persistencePath, 'utf-8');
      const state = JSON.parse(raw);

      if (state.promptExamples) {
        this.promptExamples = state.promptExamples;
      }
      if (state.toolStats) {
        this.toolStats = new Map(Object.entries(state.toolStats));
      }
      if (state.feedbackHistory) {
        this.feedbackHistory = state.feedbackHistory;
      }
      if (state.optimizationCount) {
        this.optimizationCount = state.optimizationCount;
      }
      if (state.successfulOptimizations) {
        this.successfulOptimizations = state.successfulOptimizations;
      }

      Logger.info(
        `🧬 进化引擎状态已恢复: ${this.promptExamples.length} 个示例, ${this.toolStats.size} 个工具统计`,
        'EvolutionEngine'
      );
    } catch {
      // 静默失败，不影响启动
    }
  }

  /**
   * 添加 Few-shot 示例 — 自动触发泛化
   */
  addFewShotExample(example: FewShotExample): void {
    this.fewShotExamples.push(example);

    // 保留最近 100 条
    if (this.fewShotExamples.length > 100) {
      this.fewShotExamples.shift();
    }

    // 自动触发泛化
    this.generalizeSkill(example);
  }

  /**
   * 泛化技能 — 从相似示例中提取通用模式
   */
  private generalizeSkill(newExample: FewShotExample): void {
    // 找出同类别且输入相似的示例
    const similarExamples = this.fewShotExamples.filter(
      (ex) =>
        ex.category === newExample.category &&
        this.calculateInputSimilarity(ex.input, newExample.input) > 0.3
    );

    if (similarExamples.length < 2) {
      return;
    }

    // 提取关键词
    const keywords = this.extractKeywordsFromExamples(
      similarExamples.map((ex) => ex.input)
    );

    if (keywords.length === 0) {
      return;
    }

    // 查找或创建泛化技能
    const skillName = `generalized_${newExample.category}_${keywords[0]}`;
    let skill = this.generalizedSkills.find((s) => s.name === skillName);

    if (!skill) {
      skill = {
        name: skillName,
        triggerKeywords: keywords,
        exampleCount: similarExamples.length,
        avgQuality:
          similarExamples.reduce((sum, ex) => sum + ex.quality_score, 0) /
          similarExamples.length,
        category: newExample.category,
        createdAt: Date.now(),
      };
      this.generalizedSkills.push(skill);
    } else {
      skill.exampleCount = similarExamples.length;
      skill.avgQuality =
        similarExamples.reduce((sum, ex) => sum + ex.quality_score, 0) /
        similarExamples.length;
      // 合并关键词
      for (const kw of keywords) {
        if (!skill.triggerKeywords.includes(kw)) {
          skill.triggerKeywords.push(kw);
        }
      }
    }
  }

  /**
   * 计算输入相似度 — 基于词汇重叠
   */
  private calculateInputSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(/\s+|,|\.|，|。/).filter(Boolean));
    const setB = new Set(b.split(/\s+|,|\.|，|。/).filter(Boolean));
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 从示例输入列表中提取高频关键词
   */
  private extractKeywordsFromExamples(inputs: string[]): string[] {
    const wordFrequency = new Map<string, number>();
    for (const input of inputs) {
      const words = input
        .split(/\s+|,|\.|，|。|的|了|是|在|我|你|他|她|它|个|一/)
        .filter((w) => w.length >= 2);
      for (const word of words) {
        wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
      }
    }

    return Array.from(wordFrequency.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * 匹配泛化技能 — 根据输入查找已学习的技能
   */
  matchFewShotSkill(input: string): GeneralizedSkill | null {
    if (this.generalizedSkills.length === 0) {
      return null;
    }

    let bestMatch: GeneralizedSkill | null = null;
    let bestScore = 0;

    for (const skill of this.generalizedSkills) {
      let score = 0;
      for (const keyword of skill.triggerKeywords) {
        if (input.includes(keyword)) {
          score += 1;
        }
      }
      // 归一化得分
      score = score / Math.max(skill.triggerKeywords.length, 1);

      if (score > bestScore && score > 0.2) {
        bestScore = score;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }

  /**
   * 从 Few-shot 示例中学习 — 生成泛化技能
   */
  learnFromFewShots(
    examples: FewShotExample[],
    category: string
  ): {
    name: string;
    confidence: number;
    triggerKeywords: string[];
    exampleCount: number;
    avgQuality: number;
  } | null {
    // 示例不足 2 个时不泛化
    if (examples.length < 2) {
      return null;
    }

    // 提取关键词
    const keywords = this.extractKeywordsFromExamples(
      examples.map((ex) => ex.input)
    );

    // 计算平均质量
    const avgQuality =
      examples.reduce((sum, ex) => sum + ex.quality_score, 0) / examples.length;

    // 生成技能名称
    const skillName = `fewshot-${category}-${Date.now()}`;

    // 计算置信度 — 基于示例数量和平均质量
    const confidence = Math.min(
      0.95,
      avgQuality * (1 - 1 / (examples.length + 1))
    );

    // 创建并存储泛化技能
    const skill: GeneralizedSkill = {
      name: skillName,
      triggerKeywords: keywords,
      exampleCount: examples.length,
      avgQuality,
      category,
      createdAt: Date.now(),
    };
    this.generalizedSkills.push(skill);

    // 同时添加到 fewShotExamples
    for (const ex of examples) {
      this.fewShotExamples.push(ex);
    }

    return {
      name: skillName,
      confidence,
      triggerKeywords: keywords,
      exampleCount: examples.length,
      avgQuality,
    };
  }
}
