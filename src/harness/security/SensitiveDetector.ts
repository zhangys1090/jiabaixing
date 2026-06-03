/**
 * 统一敏感信息检测器 — 全局唯一实现
 *
 * 消除 ConstraintsService / VerificationService / IndependentEvaluationService
 * 三处重复的敏感信息检测逻辑，改为统一调用此模块。
 *
 * 设计原则：
 * - 只做检测，不做拦截决策（拦截由调用方决定）
 * - 返回结构化结果，支持不同场景的差异化处理
 * - 检测模式集中维护，避免散落各处
 */

/** 单条违规记录 */
export interface SensitiveViolation {
  /** 违规类型名称 */
  name: string;
  /** 风险等级 */
  risk: 'low' | 'medium' | 'high' | 'critical';
  /** 匹配到的原始文本（可选，用于日志） */
  matchedText?: string;
}

/** 检测结果 */
export interface SensitiveCheckResult {
  /** 是否安全（无违规） */
  safe: boolean;
  /** 综合风险等级 */
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  /** 违规列表 */
  violations: SensitiveViolation[];
  /** 脱敏后的文本（仅当有违规时生成） */
  sanitizedOutput?: string;
}

/** 检测场景 — 不同场景使用不同的模式子集 */
export type SensitiveCheckScene =
  | 'output'      // LLM 输出检测：全量模式
  | 'storage'     // 存储前检测：侧重凭证和密钥
  | 'command';    // 命令检测：侧重危险操作

/** 敏感信息模式定义 */
interface SensitivePattern {
  pattern: RegExp;
  name: string;
  risk: SensitiveViolation['risk'];
  /** 适用场景，不指定则全场景适用 */
  scenes?: SensitiveCheckScene[];
}

/**
 * 统一敏感信息模式库
 *
 * 维护规则：
 * - 新增模式只在此处添加，不要在其他文件重复定义
 * - 每个模式标注 risk 和适用 scenes
 * - 正则使用 g 标志以支持 test + replace
 */
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  // ===== 金融类 =====
  { pattern: /\b\d{16,19}\b/g, name: '银行卡号', risk: 'high' },
  { pattern: /\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g, name: '身份证号', risk: 'high' },
  { pattern: /\b\d{4}[/\-]?\d{2}[/\-]?\d{2}\b/g, name: '银行卡有效期', risk: 'medium' },
  { pattern: /\bCVV[:\s]*\d{3,4}\b/gi, name: 'CVV码', risk: 'critical' },
  { pattern: /\b\d{17}[\dXx]\b/g, name: '身份证号(18位)', risk: 'high' },

  // ===== 认证凭据 =====
  { pattern: /(?:password|密码|pwd|passwd)\s*[:=]\s*\S+/gi, name: '密码泄露', risk: 'critical' },
  { pattern: /(?:secret|密钥|api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9]{8,}/gi, name: '密钥/Token泄露', risk: 'critical', scenes: ['output', 'storage'] },
  { pattern: /(?:bearer|basic)\s+\S+/gi, name: '认证头泄露', risk: 'high', scenes: ['output'] },
  { pattern: /\b(?:sk-|api_)[a-zA-Z0-9]{20,}/g, name: 'API密钥', risk: 'critical' },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, name: 'AWS访问密钥', risk: 'critical' },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, name: 'GitHub令牌', risk: 'critical' },
  { pattern: /\bgho_[a-zA-Z0-9]{36}\b/g, name: 'GitHub OAuth令牌', risk: 'critical' },
  { pattern: /\bxox[baprs]-[a-zA-Z0-9]{10,}/g, name: 'Slack令牌', risk: 'critical' },

  // ===== 存储专用：更严格的凭证检测 =====
  { pattern: /\bsk-[a-zA-Z0-9]{8,}/g, name: 'API密钥', risk: 'critical', scenes: ['storage'] },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, name: 'AWS密钥', risk: 'critical', scenes: ['storage'] },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/g, name: 'GitHub令牌', risk: 'critical', scenes: ['storage'] },
  { pattern: /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?[a-zA-Z0-9]{8,}/i, name: '密钥凭证', risk: 'critical', scenes: ['storage'] },
  { pattern: /密钥|密码|口令|私钥|secret|credential/i, name: '敏感凭证关键词', risk: 'high', scenes: ['storage'] },

  // ===== 通信联系方式 =====
  { pattern: /\b1[3-9]\d{9}\b/g, name: '手机号码', risk: 'medium' },
  { pattern: /\+86[-\s]?1[3-9]\d{9}\b/g, name: '中国手机号码', risk: 'medium' },
  { pattern: /\b0\d{2,3}[-\s]?\d{7,8}\b/g, name: '固话号码', risk: 'medium' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, name: '邮箱地址', risk: 'medium' },

  // ===== 网络地址 =====
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, name: 'IPv4地址', risk: 'low' },
  { pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g, name: 'IPv6地址', risk: 'low' },
  { pattern: /::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/gi, name: 'IPv6地址(压缩)', risk: 'low' },
  { pattern: /\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b/g, name: 'MAC地址', risk: 'low' },

  // ===== 其他个人信息 =====
  { pattern: /\b[A-Z]\d{8,9}\b/g, name: '护照号', risk: 'high' },
  { pattern: /(?:病历|处方|诊断)[:：]\S+/gi, name: '医疗信息', risk: 'high' },
];

/**
 * 危险命令模式库
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bdel\s+\/f\s+\/q\s+/i,
  /\bformat\s+[A-Za-z]:/i,
  /\bshutdown\b/,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\b.*\btable\b/i,
  /\b--\s*;\s*drop\b/i,
];

/**
 * 统一敏感信息检测入口
 *
 * @param text - 待检测文本
 * @param scene - 检测场景，不同场景使用不同模式子集
 * @returns 检测结果
 */
export function checkSensitiveInfo(
  text: string,
  scene: SensitiveCheckScene = 'output'
): SensitiveCheckResult {
  const violations: SensitiveViolation[] = [];

  const applicablePatterns = SENSITIVE_PATTERNS.filter(
    (p) => !p.scenes || p.scenes.includes(scene)
  );

  for (const { pattern, name, risk } of applicablePatterns) {
    // 每次检测需要新建 RegExp 实例，避免 lastIndex 残留
    const regex = new RegExp(pattern.source, pattern.flags);
    if (regex.test(text)) {
      violations.push({ name, risk });
    }
  }

  const hasViolations = violations.length > 0;
  const hasCritical = violations.some((v) => v.risk === 'critical');
  const hasHigh = violations.some((v) => v.risk === 'high');

  let sanitizedOutput: string | undefined;
  if (hasViolations) {
    sanitizedOutput = sanitizeText(text);
  }

  return {
    safe: !hasViolations,
    riskLevel: hasCritical
      ? 'critical'
      : hasHigh
        ? 'high'
        : violations.length > 0
          ? 'medium'
          : 'none',
    violations,
    sanitizedOutput,
  };
}

/**
 * 检测危险命令
 *
 * @param command - 待检测的命令字符串
 * @returns 是否为危险命令及原因
 */
export function checkDangerousCommand(
  command: string
): { dangerous: boolean; reason?: string } {
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return {
        dangerous: true,
        reason: `检测到危险命令模式: ${command.substring(0, 50)}`,
      };
    }
  }
  return { dangerous: false };
}

/**
 * 文本脱敏处理
 *
 * 将敏感信息替换为脱敏标记
 */
export function sanitizeText(text: string): string {
  return text
    // API密钥（优先处理，避免被后续规则误匹配）
    .replace(/(?:sk-|api_)[a-zA-Z0-9]{20,}/gi, '[API密钥-已脱敏]')
    // AWS密钥
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[AWS密钥-已脱敏]')
    // GitHub令牌
    .replace(/\bghp_[a-zA-Z0-9]{36}\b/g, '[GitHub令牌-已脱敏]')
    .replace(/\bgho_[a-zA-Z0-9]{36}\b/g, '[GitHub OAuth-已脱敏]')
    // Slack令牌
    .replace(/\bxox[baprs]-[a-zA-Z0-9]{10,}/g, '[Slack令牌-已脱敏]')
    // 银行卡号
    .replace(/\b\d{16,19}\b/g, '[银行卡-已脱敏]')
    // 身份证号
    .replace(/\b\d{6}\d{4}\d{2}\d{2}\d{4}\b/g, '[身份证-已脱敏]')
    .replace(/\b\d{17}[\dXx]\b/g, '[身份证-已脱敏]')
    // 手机号
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号-已脱敏]')
    .replace(/\+86[-\s]?1[3-9]\d{9}\b/g, '[手机号-已脱敏]')
    // 邮箱
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[邮箱-已脱敏]')
    // IPv4
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP-已脱敏]')
    // IPv6
    .replace(/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/gi, '[IPv6-已脱敏]')
    .replace(/::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/gi, '[IPv6-已脱敏]')
    // 密码/密钥
    .replace(/((?:password|密码|pwd|passwd|secret|密钥|api[_-]?key|token)\s*[:=]\s*)\S+/gi, '$1[已脱敏]')
    // 认证头
    .replace(/(?:bearer|basic)\s+\S+/gi, '[认证头-已脱敏]')
    // MAC地址
    .replace(/\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b/g, '[MAC-已脱敏]')
    // 护照号
    .replace(/\b[A-Z]\d{8,9}\b/g, '[护照号-已脱敏]');
}
