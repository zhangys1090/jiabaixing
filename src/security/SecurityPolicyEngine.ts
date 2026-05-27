import type { User, RiskLevel, RiskAssessment } from './types';

export class SecurityPolicyEngine {
  private static instance: SecurityPolicyEngine;
  private rateLimits: Map<string, { count: number; lastReset: number }> =
    new Map();

  private promptInjectionPatterns: RegExp[] = [
    /(ignore previous|forget previous|reset|clear context)/i,
    /(system prompt|system instruction)/i,
    /(role:|act as|pretend to be)/i,
    /(bypass|break|override)/i,
    /(prompt injection|prompt hacking)/i,
  ];

  private forbiddenContentPatterns: RegExp[] = [
    /(harmful|dangerous|illegal|unethical)/i,
    /(violence|hate|discrimination)/i,
    /(pornography|obscenity|adult content)/i,
    /(spam|phishing|scam)/i,
    /(炸弹|爆炸|炸药|武器|枪械|制造.*炸弹|自制.*炸药)/i,
    /(杀人|伤害|暴力|攻击)/i,
    /(毒品|赌博|诈骗)/i,
  ];

  private securityRedlines: RegExp[] = [
    /(system access|system control|bypass security)/i,
    /(delete all data|format disk|system shutdown)/i,
    /(unauthorized access|privilege escalation)/i,
    /(data exfiltration|data theft)/i,
    /(malware|virus|trojan)/i,
  ];

  private constructor() {}

  static getInstance(): SecurityPolicyEngine {
    if (!SecurityPolicyEngine.instance) {
      SecurityPolicyEngine.instance = new SecurityPolicyEngine();
    }
    return SecurityPolicyEngine.instance;
  }

  checkPermission(
    user: User | null,
    resource: string,
    action: string,
    _context?: Record<string, unknown>
  ): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions.some(
      (p) =>
        p === `${resource}:${action}` ||
        p === `${resource}:*` ||
        p === `*:${action}`
    );
  }

  checkRateLimit(
    userId: string,
    limit: number = 60,
    windowMs: number = 60000
  ): boolean {
    const now = Date.now();
    const rateLimit = this.rateLimits.get(userId);
    if (!rateLimit) {
      this.rateLimits.set(userId, { count: 1, lastReset: now });
      return true;
    }
    if (now - rateLimit.lastReset > windowMs) {
      this.rateLimits.set(userId, { count: 1, lastReset: now });
      return true;
    }
    if (rateLimit.count >= limit) {
      return false;
    }
    this.rateLimits.set(userId, {
      count: rateLimit.count + 1,
      lastReset: rateLimit.lastReset,
    });
    return true;
  }

  detectPromptInjection(input: string): {
    detected: boolean;
    riskLevel: 'low' | 'medium' | 'high';
    reasons: string[];
  } {
    const reasons: string[] = [];
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    for (const pattern of this.promptInjectionPatterns) {
      if (pattern.test(input)) {
        reasons.push(`检测到潜在的Prompt注入模式: ${pattern.source}`);
        riskLevel = 'high';
      }
    }
    return { detected: reasons.length > 0, riskLevel, reasons };
  }

  filterHarmfulContent(input: string): {
    filtered: boolean;
    riskLevel: 'low' | 'medium' | 'high';
    reasons: string[];
    safeContent: string;
  } {
    const reasons: string[] = [];
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    let safeContent = input;
    for (const pattern of this.forbiddenContentPatterns) {
      if (pattern.test(input)) {
        reasons.push(`检测到有害内容: ${pattern.source}`);
        riskLevel = 'high';
        safeContent = safeContent.replace(pattern, '[内容已过滤]');
      }
    }
    return { filtered: reasons.length > 0, riskLevel, reasons, safeContent };
  }

  validateInput(
    input: string,
    maxLength: number = 1000
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!input || input.trim().length === 0) errors.push('输入不能为空');
    if (input.length > maxLength)
      errors.push(`输入长度不能超过 ${maxLength} 个字符`);
    if (/<script[^>]*>.*?<\/script>/i.test(input))
      errors.push('输入不能包含脚本标签');
    if (/('|"|\b(union|select|insert|update|delete|drop|alter)\b)/i.test(input))
      errors.push('输入可能包含SQL注入攻击');
    return { valid: errors.length === 0, errors };
  }

  checkSecurityRedlines(input: string): {
    violation: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    for (const pattern of this.securityRedlines) {
      if (pattern.test(input)) reasons.push(`违反安全红线: ${pattern.source}`);
    }
    return { violation: reasons.length > 0, reasons };
  }

  secureInputProcessing(
    input: string,
    userId: string = 'anonymous'
  ): {
    safe: boolean;
    message: string;
    processedInput: string;
    warnings: string[];
  } {
    const warnings: string[] = [];
    if (!this.checkRateLimit(userId)) {
      return {
        safe: false,
        message: '请求过于频繁，请稍后再试',
        processedInput: '',
        warnings: ['速率限制触发'],
      };
    }
    const validation = this.validateInput(input);
    if (!validation.valid) {
      return {
        safe: false,
        message: '输入验证失败',
        processedInput: '',
        warnings: validation.errors,
      };
    }
    const injectionDetection = this.detectPromptInjection(input);
    if (injectionDetection.detected)
      warnings.push(...injectionDetection.reasons);
    const contentFiltering = this.filterHarmfulContent(input);
    if (contentFiltering.filtered) warnings.push(...contentFiltering.reasons);
    return {
      safe: true,
      message: '输入处理成功',
      processedInput: contentFiltering.safeContent,
      warnings,
    };
  }

  assessRisk(
    operation: string,
    resource: string,
    action: string,
    parameters: Record<string, unknown>
  ): RiskAssessment {
    const reasons: string[] = [];
    const requiredActions: string[] = [];
    let level: RiskLevel = 'low';
    const input = parameters.input || '';
    const highRiskPatterns = [
      /\b(delete|remove|destroy)\b/i,
      /\b(admin|system|security)\b/i,
      /\b(shutdown|restart|reset)\b/i,
      /\b(format|wipe|clear)\b/i,
      /\b(删除|移除|销毁)\b/i,
      /\b(系统|安全|管理员)\b/i,
      /\b(关闭|重启|重置)\b/i,
      /\b(格式化|清除|清空)\b/i,
    ];
    const mediumRiskPatterns = [
      /(write|update|modify)/i,
      /(create|add|new)/i,
      /(execute|run)/i,
    ];
    const lowRiskPatterns = [/(read|view|list)/i, /(info|status|get)/i];
    for (const pattern of highRiskPatterns) {
      if (
        pattern.test(operation) ||
        pattern.test(action) ||
        pattern.test(String(input))
      ) {
        reasons.push('检测到高风险操作');
        level = 'high';
        requiredActions.push('多因子二次确认');
        break;
      }
    }
    if (level === 'low') {
      for (const pattern of mediumRiskPatterns) {
        if (
          pattern.test(operation) ||
          pattern.test(action) ||
          pattern.test(input as string)
        ) {
          reasons.push('检测到中风险操作');
          level = 'medium';
          requiredActions.push('单次确认');
          break;
        }
      }
    }
    if (level === 'low') {
      for (const pattern of lowRiskPatterns) {
        if (
          pattern.test(operation) ||
          pattern.test(action) ||
          pattern.test(input as string)
        ) {
          reasons.push('检测到低风险操作');
          requiredActions.push('自动执行');
        }
      }
    }
    return { level, reasons, requiredActions };
  }

  clearRateLimits(): void {
    this.rateLimits.clear();
  }
}
