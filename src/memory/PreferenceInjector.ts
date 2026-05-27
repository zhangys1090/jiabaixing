/**
 * 偏好注入器
 * 将用户偏好和进化学习示例动态注入到 LLM system prompt 中
 */

import { OptimizationResultDispatcher } from '../evolution/OptimizationResultDispatcher';
import { PreferenceManager } from './PreferenceManager';

/**
 * 构建偏好注入块，追加到 system prompt 末尾
 */
export function buildPreferenceBlock(): string {
  const prefManager = PreferenceManager.getInstance();
  if (prefManager.count === 0) return '';

  const summary = prefManager.getSummary();
  const blocks: string[] = [];

  if (summary.namingRules.length > 0) {
    blocks.push(`命名规范：${summary.namingRules.join('；')}`);
  }

  if (summary.codingStyle.length > 0) {
    blocks.push(`代码风格：${summary.codingStyle.join('；')}`);
  }

  if (summary.frameworkPreferences.length > 0) {
    blocks.push(`框架偏好：${summary.frameworkPreferences.join('；')}`);
  }

  if (summary.workflowPreferences.length > 0) {
    blocks.push(`工作流程：${summary.workflowPreferences.join('；')}`);
  }

  if (summary.recentCorrections.length > 0) {
    blocks.push(
      `最近用户纠错（务必注意）：${summary.recentCorrections.join('；')}`
    );
  }

  if (blocks.length === 0) return '';

  return `\n\n【用户偏好】\n${blocks.join('\n')}`;
}

/**
 * 构建进化学习示例注入块
 * 从 OptimizationResultDispatcher 获取最新的 PromptExamples 并注入
 */
export function buildEvolutionExamplesBlock(): string {
  const dispatcher = OptimizationResultDispatcher.getInstance();
  const snapshot = dispatcher.getLastSnapshot();
  if (!snapshot || !snapshot.promptExamples || snapshot.promptExamples.length === 0) {
    return '';
  }

  const examples = snapshot.promptExamples.slice(-5);
  const lines: string[] = [];

  for (const ex of examples) {
    lines.push(`- 当用户说"${ex.trigger}"时，正确做法：${ex.correction}`);
  }

  if (lines.length === 0) return '';

  return `\n\n【进化学习示例】（从历史纠错中学习，务必遵循）\n${lines.join('\n')}`;
}

/**
 * 将偏好和进化学习示例注入到 system prompt 中
 */
export function injectPreferences(systemPrompt: string): string {
  const prefBlock = buildPreferenceBlock();
  const examplesBlock = buildEvolutionExamplesBlock();

  let result = systemPrompt;
  if (prefBlock) result += prefBlock;
  if (examplesBlock) result += examplesBlock;

  return result;
}
