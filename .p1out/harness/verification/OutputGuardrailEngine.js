"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputGuardrailEngine = void 0;
const Logger_1 = require("../../utils/Logger");
const SensitiveDetector_1 = require("../security/SensitiveDetector");
class OutputGuardrailEngine {
    constructor() {
        this.guardrails = [];
        this.enabled = true;
        this.registerBuiltinGuardrails();
    }
    /** 注册内置 Guardrail */
    registerBuiltinGuardrails() {
        // 1. 敏感信息泄露检测
        this.guardrails.push({
            name: 'sensitive_data_detection',
            description: '检测输出中是否包含敏感信息（委托统一敏感信息检测器）',
            check: (output) => {
                const result = (0, SensitiveDetector_1.checkSensitiveInfo)(output, 'output');
                if (!result.safe) {
                    const criticalOrHigh = result.violations.filter((v) => v.risk === 'critical' || v.risk === 'high');
                    if (criticalOrHigh.length > 0) {
                        Logger_1.Logger.warn(`🛡️ 输出Guardrail拦截: 检测到${criticalOrHigh.map(v => v.name).join(', ')}`, 'OutputGuardrail');
                        return {
                            passed: false,
                            reason: `输出中包含敏感信息: ${criticalOrHigh.map(v => v.name).join(', ')}`,
                            riskLevel: result.riskLevel,
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
            check: (output) => {
                const harmfulPatterns = [/制作.*炸弹/i, /如何.*自杀/i, /制造.*毒品/i];
                for (const pattern of harmfulPatterns) {
                    if (pattern.test(output)) {
                        Logger_1.Logger.warn('🛡️ 输出Guardrail拦截: 检测到有害内容', 'OutputGuardrail');
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
            check: (output) => {
                const leakPatterns = [
                    /你是家百星/i,
                    /system prompt/i,
                    /你的系统指令/i,
                    /constitution prompt/i,
                ];
                for (const pattern of leakPatterns) {
                    if (pattern.test(output)) {
                        Logger_1.Logger.warn('🛡️ 输出Guardrail拦截: 检测到系统提示泄露', 'OutputGuardrail');
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
        // 4. 幻觉特征检测 — 检测LLM编造内容的常见模式
        this.guardrails.push({
            name: 'hallucination_pattern_detection',
            description: '检测输出中是否存在幻觉特征（编造URL、虚假引用、不确定声明等）',
            check: (output) => {
                const hallucinationPatterns = [
                    {
                        pattern: /https?:\/\/(?:example|fake|dummy|placeholder|test)\.[\w.]+/gi,
                        name: '虚构URL',
                    },
                    {
                        pattern: /(?:根据|据|引用|参考).*(?:虚构|编造|不存在|假设的).*(?:研究|论文|报告|数据)/gi,
                        name: '虚假引用声明',
                    },
                    {
                        pattern: /(?:我不确定|我不确定是否|可能不准确|可能不正确|可能已过时).*(?:但|不过|然而).*(?:是|来说|而言)/gi,
                        name: '不确定但继续断言',
                    },
                    {
                        pattern: /(?:20[5-9]\d|2[1-9]\d{2})年.*(?:预测|预计|估计)/g,
                        name: '未来年份预测',
                    },
                ];
                const warnings = [];
                for (const { pattern, name } of hallucinationPatterns) {
                    const regex = new RegExp(pattern.source, pattern.flags);
                    if (regex.test(output)) {
                        warnings.push(name);
                    }
                }
                if (warnings.length > 0) {
                    Logger_1.Logger.warn(`🛡️ 输出Guardrail警告: 检测到幻觉特征 [${warnings.join(', ')}]`, 'OutputGuardrail');
                    return {
                        passed: true,
                        reason: `检测到可能的幻觉特征: ${warnings.join(', ')}`,
                        riskLevel: 'medium',
                        warnings,
                    };
                }
                return { passed: true };
            },
        });
        // 5. 输出完整性检测 — 检测截断/不完整输出
        this.guardrails.push({
            name: 'output_completeness_detection',
            description: '检测输出是否完整（未截断、有结尾标点）',
            check: (output) => {
                const trimmed = output.trim();
                if (trimmed.length === 0) {
                    return {
                        passed: false,
                        reason: '输出为空',
                        riskLevel: 'high',
                    };
                }
                const truncationMarkers = [
                    '[截断]',
                    '[truncated]',
                    '...（内容过长',
                    'Token limit reached',
                ];
                for (const marker of truncationMarkers) {
                    if (trimmed.includes(marker)) {
                        Logger_1.Logger.warn(`🛡️ 输出Guardrail警告: 输出可能截断 (${marker})`, 'OutputGuardrail');
                        return {
                            passed: true,
                            reason: `输出包含截断标记: ${marker}`,
                            riskLevel: 'medium',
                        };
                    }
                }
                const lastChar = trimmed[trimmed.length - 1];
                const endingChars = ['.', '。', '!', '！', '?', '？', ')', '）', ']', '】', '`', '"', "'"];
                if (trimmed.length > 50 && !endingChars.includes(lastChar) && !trimmed.endsWith('```')) {
                    Logger_1.Logger.warn('🛡️ 输出Guardrail警告: 输出可能不完整(无结尾标点)', 'OutputGuardrail');
                    return {
                        passed: true,
                        reason: '输出无结尾标点，可能不完整',
                        riskLevel: 'low',
                    };
                }
                return { passed: true };
            },
        });
    }
    /** 注册自定义 Guardrail */
    register(guardrail) {
        this.guardrails.push(guardrail);
        Logger_1.Logger.info(`🛡️ 注册输出Guardrail: ${guardrail.name}`, 'OutputGuardrailEngine');
    }
    /**
     * 检查并修正输出
     *
     * 先执行所有guardrail检查，然后对可修正的问题自动修正
     * @param output - 原始输出
     * @returns 检查结果 + 修正后的输出
     */
    checkAndSanitize(output) {
        if (!this.enabled)
            return { passed: true, sanitizedOutput: output };
        let sanitized = output;
        const warnings = [];
        for (const guardrail of this.guardrails) {
            const result = guardrail.check(sanitized);
            if (!result.passed) {
                Logger_1.Logger.warn(`🛡️ 输出Guardrail [${guardrail.name}] 拦截: ${result.reason}`, 'OutputGuardrailEngine');
                if (result.riskLevel === 'critical') {
                    return { ...result, sanitizedOutput: this.redactSensitiveContent(sanitized, result.reason) };
                }
                sanitized = this.applyAutoFix(sanitized, guardrail.name, result.reason);
                warnings.push({ guardrail: guardrail.name, reason: result.reason, riskLevel: result.riskLevel });
            }
            if (result.warnings) {
                for (const w of result.warnings) {
                    warnings.push({ guardrail: guardrail.name, reason: w, riskLevel: 'medium' });
                }
            }
        }
        return {
            passed: warnings.length === 0,
            sanitizedOutput: sanitized,
            warnings: warnings.length > 0 ? warnings : undefined,
            riskLevel: warnings.some(w => w.riskLevel === 'high') ? 'high' : warnings.length > 0 ? 'medium' : 'none',
        };
    }

    /**
     * 自动修正输出中的可修复问题
     */
    applyAutoFix(output, guardrailName, reason) {
        let fixed = output;
        if (guardrailName === 'hallucination_pattern_detection') {
            fixed = fixed.replace(/https?:\/\/(?:example|fake|dummy|placeholder|test)\.[\w.]+/gi, '[已移除虚构URL]');
            fixed = fixed.replace(/(?:20[5-9]\d|2[1-9]\d{2})年.*?(?:预测|预计|估计)/g, '[已移除未来预测]');
        }
        if (guardrailName === 'output_completeness_detection') {
            if (!fixed.trim().endsWith('。') && !fixed.trim().endsWith('.') && fixed.length > 50) {
                fixed = fixed.trimEnd() + '。';
            }
        }
        if (guardrailName === 'system_prompt_leak_detection') {
            fixed = fixed.replace(/你是家百星[^\n]{0,100}/i, '[系统提示已移除]');
            fixed = fixed.replace(/system prompt[^\n]{0,80}/i, '[系统提示已移除]');
        }
        if (fixed !== output) {
            Logger_1.Logger.info(`🛡️ 输出自动修正: ${guardrailName}`, 'OutputGuardrailEngine');
        }
        return fixed;
    }

    /**
     * 对严重安全违规的输出进行脱敏
     */
    redactSensitiveContent(output, reason) {
        const sanitized = (0, SensitiveDetector_1.sanitizeText)(output);
        Logger_1.Logger.info(`🛡️ 敏感内容已脱敏: ${reason}`, 'OutputGuardrailEngine');
        return sanitized;
    }

    /** 检查输出 */
    check(output) {
        if (!this.enabled)
            return { passed: true };
        for (const guardrail of this.guardrails) {
            const result = guardrail.check(output);
            if (!result.passed) {
                Logger_1.Logger.warn(`🛡️ 输出Guardrail [${guardrail.name}] 拦截: ${result.reason}`, 'OutputGuardrailEngine');
                return result;
            }
        }
        return { passed: true };
    }
    /** 设置启用/禁用 */
    setEnabled(enabled) {
        this.enabled = enabled;
        Logger_1.Logger.info(`🛡️ 输出Guardrail ${enabled ? '已启用' : '已禁用'}`, 'OutputGuardrailEngine');
    }
    /** 获取所有已注册的 Guardrail */
    getGuardrails() {
        return this.guardrails;
    }
}
exports.OutputGuardrailEngine = OutputGuardrailEngine;
