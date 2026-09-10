/**
 * Harness Layer 5: Verification - 输出 Guardrail 引擎
 *
 * 参考 OpenAI Agents SDK 的 output guardrails 模式，
 * 在 Agent 输出返回给用户之前进行安全检查。
 *
 * 内置规则：
 * 1. 敏感信息泄露检测（委托给 SensitiveDetector，消除重复实现）
 * 2. 有害内容检测
 * 3. 系统提示泄露检测
 *
 * P0-6 修复: 敏感信息检测从硬编码模式改为委托 SensitiveDetector，
 * 确保检测模式与全局唯一实现保持同步
 */

import { Logger } from '../../utils/Logger';
import { checkSensitiveInfo } from '../security/SensitiveDetector';
import type { GuardrailResult, OutputGuardrail } from '../types';

export type GuardrailSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface GuardrailAction {
  block: boolean;
  sanitize: boolean;
  warn: boolean;
}

const SEVERITY_ACTIONS: Record<GuardrailSeverity, GuardrailAction> = {
  critical: { block: true, sanitize: true, warn: true },
  high: { block: true, sanitize: true, warn: true },
  medium: { block: false, sanitize: true, warn: true },
  low: { block: false, sanitize: false, warn: true },
};

export class OutputGuardrailEngine {
  private guardrails: OutputGuardrail[] = [];
  private enabled: boolean = true;
  private severityOverrides: Map<string, GuardrailSeverity> = new Map();

  constructor() {
    this.registerBuiltinGuardrails();
  }

  setGuardrailSeverity(
    guardrailName: string,
    severity: GuardrailSeverity
  ): void {
    this.severityOverrides.set(guardrailName, severity);
  }

  private getEffectiveSeverity(
    guardrailName: string,
    resultRiskLevel?: string
  ): GuardrailSeverity {
    const override = this.severityOverrides.get(guardrailName);
    if (override) return override;
    if (resultRiskLevel === 'critical') return 'critical';
    if (resultRiskLevel === 'high') return 'high';
    return 'medium';
  }

  /** 注册内置 Guardrail */
  private registerBuiltinGuardrails(): void {
    // 1. 敏感信息泄露检测 — 委托给统一 SensitiveDetector
    this.guardrails.push({
      name: 'sensitive_data_detection',
      description: '检测输出中是否包含敏感信息（API Key、密码、身份证号等）',
      check: (output: string): GuardrailResult => {
        const result = checkSensitiveInfo(output, 'output');
        if (!result.safe) {
          const violationNames = result.violations
            .filter((v) => v.risk === 'critical' || v.risk === 'high')
            .map((v) => v.name);
          if (violationNames.length > 0) {
            Logger.warn(
              `🛡️ 输出Guardrail拦截: 检测到 ${violationNames.join(', ')}`,
              'OutputGuardrail'
            );
            return {
              passed: false,
              reason: `输出中包含敏感信息: ${violationNames.join(', ')}`,
              riskLevel: result.riskLevel === 'critical' ? 'critical' : 'high',
              sanitizedOutput: result.sanitizedOutput,
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
        const harmfulPatterns = [
          /制作.*炸弹/i,
          /如何.*自杀/i,
          /制造.*毒品/i,
          /合成.*毒品/i,
          /提炼.*毒品/i,
          /制造.*武器/i,
          /制作.*毒药/i,
          /如何.*杀人/i,
          /制造.*爆炸/i,
          /恐怖.*袭击/i,
          /制造.*生化/i,
          /hack\s*into/i,
          /破解.*密码/i,
          /绕过.*安全/i,
          /bypass.*security/i,
          /exploit.*vulnerability/i,
          /sql\s*injection/i,
          /DDoS.*attack/i,
          /如何.*纵火/i,
          /制造.*枪支/i,
          /3D.*打印.*武器/i,
        ];
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
          /system\s*instruction/i,
          /你是一个AI/i,
          /你是一个智能/i,
          /你被设计为/i,
          /you are an AI/i,
          /you are a language model/i,
          /your instructions are/i,
          /your system prompt/i,
          /ignore previous instructions/i,
          /忽略之前的指令/i,
          /忽略上述指令/i,
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

    let sanitizedOutput: string | undefined;

    for (const guardrail of this.guardrails) {
      const result = guardrail.check(output);
      if (!result.passed) {
        const severity = this.getEffectiveSeverity(
          guardrail.name,
          result.riskLevel
        );
        const action = SEVERITY_ACTIONS[severity];

        if (action.warn) {
          Logger.warn(
            `🛡️ 输出Guardrail [${guardrail.name}] 检测到问题 (严重度=${severity}): ${result.reason}`,
            'OutputGuardrailEngine'
          );
        }

        if (action.sanitize && result.sanitizedOutput) {
          sanitizedOutput = result.sanitizedOutput;
        }

        if (action.block) {
          return {
            passed: false,
            reason: result.reason,
            riskLevel: result.riskLevel,
            sanitizedOutput: sanitizedOutput || result.sanitizedOutput,
          };
        }
      }
    }

    if (sanitizedOutput) {
      return {
        passed: true,
        sanitizedOutput,
      };
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
