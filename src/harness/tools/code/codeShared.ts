/**
 * codeShared — 代码工具共享中间件（D3：code_generate/review/fix 共用）
 *
 * 提供语言无关的生成物安全扫描：
 *   - 硬编码密钥/令牌/密码检测（API Key / Secret / Token / Password / JWT / 私钥等）
 *   - 基础括号配平检查（() {} [] 是否成对）
 *
 * 设计为纯函数、零依赖，便于 code_generate / code_review / code_fix 三者复用，
 * 保证「生成物安全扫描」一致，避免各自实现导致行为漂移。
 */

export interface CodeScanResult {
  /** 命中的敏感片段（已做掩码，仅保留前后缀用于定位） */
  secrets: string[];
  /** 可读性告警（含密钥风险与括号不平衡） */
  warnings: string[];
}

// 仅做存在性检测，命中后做掩码，绝不原样回显密钥
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  {
    name: 'Private Key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'Credential Assignment',
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|access[_-]?token)\s*[:=]\s*['"][^'"]{6,}['"]/i,
  },
];

function mask(match: string): string {
  if (match.length <= 6) return '***';
  return `${match.slice(0, 3)}…${match.slice(-3)}`;
}

function checkBalance(code: string): string | null {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const open = new Set(['(', '[', '{']);
  const stack: string[] = [];
  let inString: string | null = null;
  let escaped = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (open.has(ch)) stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return '括号不匹配';
    }
  }
  if (stack.length > 0) return '括号未闭合';
  return null;
}

/**
 * 扫描生成/修复后的代码，返回敏感命中与告警。
 * 纯函数，不修改入参。
 */
export function scanGeneratedCode(code: string): CodeScanResult {
  const warnings: string[] = [];
  const secrets: string[] = [];

  for (const { name, re } of SECRET_PATTERNS) {
    const m = code.match(re);
    if (m) {
      secrets.push(`${name}: ${mask(m[0])}`);
      warnings.push(`⚠️ 检测到疑似硬编码 ${name}，请勿将密钥写入生成物`);
    }
  }

  const balance = checkBalance(code);
  if (balance) warnings.push(`⚠️ ${balance}，请检查生成物语法`);

  return { secrets, warnings };
}
