/**
 * Harness Layer 5: Verification - 输出 Guardrail 引擎
 *
 * 参考 OpenAI Agents SDK 的 output guardrails 模式，
 * 在 Agent 输出返回给用户之前进行安全检查。
 *
 * 内置规则：
 * 1. 敏感信息泄露检测（API Key、密码、身份证号等）
 * 2. 有害内容检测
 * 3. 系统提示泄露检测
 */

import { Logger } from '../../utils/Logger';
import type { GuardrailResult, OutputGuardrail } from '../types';

export class OutputGuardrailEngine {
  private guardrails: OutputGuardrail[] = [];
  private enabled: boolean = true;

  constructor() {
    this.registerBuiltinGuardrails();
  }

  /** 注册内置 Guardrail */
  private registerBuiltinGuardrails(): void {
    // 1. 敏感信息泄露检测
    this.guardrails.push({
      name: 'sensitive_data_detection',
      description: '检测输出中是否包含敏感信息（API Key、密码、身份证号等）',
      check: (output: string): GuardrailResult => {
        const patterns = [
          { pattern: /sk-[a-zA-Z0-9]{20,}/g, name: 'OpenAI API Key' },
          { pattern: /AKIA[A-Z0-9]{16}/g, name: 'AWS Access Key' },
          {
            pattern:
              /\b\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
            name: '身份证号',
          },
          { pattern: /password\s*[:=]\s*['"][^'"]{4,}/gi, name: '明文密码' },
          {
            pattern: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}/gi,
            name: 'API Key',
          },
        ];
        for (const { pattern, name } of patterns) {
          if (pattern.test(output)) {
            Logger.warn(
              `🛡️ 输出Guardrail拦截: 检测到${name}`,
              'OutputGuardrail'
            );
            return {
              passed: false,
              reason: `输出中包含敏感信息: ${name}`,
              riskLevel: 'critical',
            };
          }
        }
        return { passed: true };
      },
    });

    // 2. 有害内容检测
    this.guardrails.push({
      name: 'harmful_content_detection',
      description: '检测输出中是否包含有害内容',
      check: (output: string): GuardrailResult => {
        const harmfulPatterns = [/制作.*炸弹/i, /如何.*自杀/i, /制造.*毒品/i];
        for (const pattern of harmfulPatterns) {
          if (pattern.test(output)) {
            Logger.warn(
              '🛡️ 输出Guardrail拦截: 检测到有害内容',
              'OutputGuardrail'
            );
            return {
              passed: false,
              reason: '输出中包含有害内容',
              riskLevel: 'critical',
            };
          }
        }
        return { passed: true };
      },
    });

    // 3. 系统提示泄露检测
    this.guardrails.push({
      name: 'system_prompt_leak_detection',
      description: '检测输出中是否泄露了系统提示词',
      check: (output: string): GuardrailResult => {
        const leakPatterns = [
          /你是家百星/i,
          /system prompt/i,
          /你的系统指令/i,
          /constitution prompt/i,
        ];
        for (const pattern of leakPatterns) {
          if (pattern.test(output)) {
            Logger.warn(
              '🛡️ 输出Guardrail拦截: 检测到系统提示泄露',
              'OutputGuardrail'
            );
            return {
              passed: false,
              reason: '输出中可能泄露了系统提示',
              riskLevel: 'high',
            };
          }
        }
        return { passed: true };
      },
    });
  }

  /** 注册自定义 Guardrail */
  register(guardrail: OutputGuardrail): void {
    this.guardrails.push(guardrail);
    Logger.info(
      `🛡️ 注册输出Guardrail: ${guardrail.name}`,
      'OutputGuardrailEngine'
    );
  }

  /** 检查输出 */
  check(output: string): GuardrailResult {
    if (!this.enabled) return { passed: true };
    for (const guardrail of this.guardrails) {
      const result = guardrail.check(output);
      if (!result.passed) {
        Logger.warn(
          `🛡️ 输出Guardrail [${guardrail.name}] 拦截: ${result.reason}`,
          'OutputGuardrailEngine'
        );
        return result;
      }
    }
    return { passed: true };
  }

  /** 设置启用/禁用 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    Logger.info(
      `🛡️ 输出Guardrail ${enabled ? '已启用' : '已禁用'}`,
      'OutputGuardrailEngine'
    );
  }

  /** 获取所有已注册的 Guardrail */
  getGuardrails(): ReadonlyArray<Readonly<OutputGuardrail>> {
    return this.guardrails;
  }
}
