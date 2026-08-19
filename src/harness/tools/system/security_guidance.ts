/**
 * Harness Tool: security_guidance - 安全指导
 *
 * 提供安全编码指导、敏感信息检测、安全配置审计。
 * 帮助用户在开发过程中遵循安全规范。
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const SECURITY_GUIDANCE_DEF: ToolDefinition = {
  name: 'security_guidance',
  description:
    '安全指导工具。提供安全编码建议、敏感信息检测、安全配置审计。支持操作：check=安全检查, scan_secrets=敏感信息扫描, audit_config=配置审计, best_practices=最佳实践建议。适用场景：代码安全审查、敏感信息泄露检测、安全配置验证。',
  category: ToolCategory.SYSTEM,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型：check|scan_secrets|audit_config|best_practices',
      enum: ['check', 'scan_secrets', 'audit_config', 'best_practices'],
    },
    directory: {
      type: 'string',
      description: '项目根目录路径，默认为当前工作目录',
    },
    category: {
      type: 'string',
      description:
        '安全类别：all|injection|xss|auth|crypto|secrets|config|deps',
      enum: [
        'all',
        'injection',
        'xss',
        'auth',
        'crypto',
        'secrets',
        'config',
        'deps',
      ],
      default: 'all',
    },
    severity: {
      type: 'string',
      description: '最低报告严重级别：info|warning|error|critical',
      enum: ['info', 'warning', 'error', 'critical'],
      default: 'warning',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.FILE_READ],
  riskLevel: 'low',
  idempotent: true,
  timeout: 30000,
};

interface SecurityFinding {
  category: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};
const SEVERITY_ICON: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '🟠',
  critical: '🔴',
};

const SECRET_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  severity: SecurityFinding['severity'];
}> = [
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    name: '硬编码密码',
    severity: 'critical',
  },
  {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    name: 'API Key 泄露',
    severity: 'critical',
  },
  {
    pattern: /(?:secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    name: 'Secret/Token 泄露',
    severity: 'critical',
  },
  {
    pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
    name: 'AWS Access Key',
    severity: 'critical',
  },
  {
    pattern: /ghp_[0-9a-zA-Z]{36}/g,
    name: 'GitHub Personal Access Token',
    severity: 'critical',
  },
  {
    pattern: /sk-[0-9a-zA-Z]{32,}/g,
    name: 'OpenAI API Key',
    severity: 'critical',
  },
  {
    pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    name: '私钥文件',
    severity: 'critical',
  },
  {
    pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/gi,
    name: 'MongoDB 连接字符串含密码',
    severity: 'critical',
  },
  {
    pattern: /mysql:\/\/[^:]+:[^@]+@/gi,
    name: 'MySQL 连接字符串含密码',
    severity: 'critical',
  },
  {
    pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@/gi,
    name: 'PostgreSQL 连接字符串含密码',
    severity: 'critical',
  },
  {
    pattern: /jwt[_-]?secret\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    name: 'JWT Secret 硬编码',
    severity: 'error',
  },
  { pattern: /eval\s*\(/g, name: 'eval() 使用', severity: 'warning' },
  {
    pattern: /innerHTML\s*=/g,
    name: 'innerHTML 赋值（XSS风险）',
    severity: 'warning',
  },
];

const INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  name: string;
  suggestion: string;
}> = [
  {
    pattern: /eval\s*\(\s*(?:req\.|request\.|params\.|query\.|body\.)/g,
    name: '用户输入直接传入 eval()',
    suggestion: '避免使用 eval()，使用 JSON.parse() 或其他安全替代方案',
  },
  {
    pattern: /exec\s*\(\s*['"`].*\$\{/g,
    name: '命令注入风险（模板字符串拼接命令）',
    suggestion: '使用 execFile() 代替 exec()，参数化传递用户输入',
  },
  {
    pattern: /query\s*\(\s*['"`].*\$\{/gi,
    name: 'SQL 注入风险（模板字符串拼接SQL）',
    suggestion: '使用参数化查询（prepared statements）',
  },
];

const GITIGNORE_REQUIRED = [
  '.env',
  '.env.local',
  '.env.*.local',
  'node_modules',
  '*.pem',
  '*.key',
  '*.p12',
  'credentials.json',
  'serviceAccountKey.json',
];

function scanForSecrets(
  projectRoot: string,
  minSeverity: string
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const minOrder = SEVERITY_ORDER[minSeverity] || 2;

  function scanFile(filePath: string, relPath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const { pattern, name, severity } of SECRET_PATTERNS) {
        if (SEVERITY_ORDER[severity] < minOrder) continue;
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            findings.push({
              category: 'secrets',
              severity,
              title: name,
              description: `在 ${relPath} 中发现敏感信息模式`,
              file: relPath,
              line: i + 1,
              suggestion: '将敏感信息移至环境变量或密钥管理服务',
            });
            pattern.lastIndex = 0;
          }
        }
      }

      for (const { pattern, name, suggestion } of INJECTION_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            findings.push({
              category: 'injection',
              severity: 'error',
              title: name,
              description: `在 ${relPath} 中发现注入风险`,
              file: relPath,
              line: i + 1,
              suggestion,
            });
            pattern.lastIndex = 0;
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  function walkDir(dir: string, depth: number = 0): void {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      if (
        ['node_modules', 'dist', 'build', '.git', 'coverage'].includes(
          entry.name
        )
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(projectRoot, fullPath);
      if (entry.isDirectory()) {
        walkDir(fullPath, depth + 1);
      } else if (
        /\.(ts|tsx|js|jsx|json|env|yaml|yml|toml|ini|cfg|conf)$/.test(
          entry.name
        ) ||
        entry.name === '.env'
      ) {
        scanFile(fullPath, relPath);
      }
    }
  }

  walkDir(projectRoot);
  return findings;
}

function auditGitignore(projectRoot: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    findings.push({
      category: 'config',
      severity: 'error',
      title: '缺少 .gitignore',
      description: '项目没有 .gitignore 文件，敏感文件可能被提交',
      suggestion: '创建 .gitignore 并添加常见的敏感文件模式',
    });
    return findings;
  }

  for (const required of GITIGNORE_REQUIRED) {
    if (!content.includes(required)) {
      findings.push({
        category: 'config',
        severity: 'warning',
        title: `.gitignore 缺少 ${required}`,
        description: `${required} 未在 .gitignore 中排除`,
        suggestion: `在 .gitignore 中添加 ${required}`,
      });
    }
  }
  return findings;
}

function auditEnvFiles(projectRoot: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const envExample = path.join(projectRoot, '.env.example');
  const envLocal = path.join(projectRoot, '.env');

  if (fs.existsSync(envLocal) && !fs.existsSync(envExample)) {
    findings.push({
      category: 'config',
      severity: 'warning',
      title: '缺少 .env.example',
      description: '有 .env 文件但没有 .env.example 模板',
      suggestion: '创建 .env.example 列出所需环境变量（不含实际值）',
    });
  }

  if (fs.existsSync(envLocal)) {
    try {
      const lines = fs.readFileSync(envLocal, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#') && line.includes('=')) {
          const value = line.split('=').slice(1).join('=').trim();
          if (
            value &&
            !value.includes('xxx') &&
            !value.includes('TODO') &&
            !value.includes('your_')
          ) {
            findings.push({
              category: 'secrets',
              severity: 'warning',
              title: '.env 包含实际值',
              description: `.env 第${i + 1}行可能包含实际的敏感值`,
              file: '.env',
              line: i + 1,
              suggestion:
                '确保 .env 已在 .gitignore 中排除，使用 .env.example 提供模板',
            });
            break;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return findings;
}

function getBestPractices(category: string): SecurityFinding[] {
  const practices: SecurityFinding[] = [];
  const allPractices: Record<
    string,
    Array<Omit<SecurityFinding, 'category'>>
  > = {
    injection: [
      {
        severity: 'info',
        title: 'SQL 注入防护',
        description: '始终使用参数化查询，不要拼接用户输入到 SQL 语句中',
        suggestion: '使用 prepared statements 或 ORM 的查询构建器',
      },
      {
        severity: 'info',
        title: '命令注入防护',
        description: '不要将用户输入直接传递给 shell 命令',
        suggestion: '使用 execFile() 代替 exec()，参数化传递',
      },
      {
        severity: 'info',
        title: 'XSS 防护',
        description: '不要使用 innerHTML 或 v-html 渲染用户输入',
        suggestion: '使用 textContent 或框架的安全渲染机制',
      },
    ],
    auth: [
      {
        severity: 'info',
        title: '密码存储',
        description: '使用 bcrypt/argon2 哈希存储密码，不要明文存储',
        suggestion: 'bcrypt.hash(password, 12) 或 argon2.hash(password)',
      },
      {
        severity: 'info',
        title: 'JWT 安全',
        description: 'JWT Secret 应从环境变量读取，设置合理过期时间',
        suggestion: '使用 RS256 或 ES256 算法，设置 expiresIn',
      },
      {
        severity: 'info',
        title: 'HTTPS 强制',
        description: '生产环境必须使用 HTTPS',
        suggestion: '配置 HSTS 头，重定向 HTTP 到 HTTPS',
      },
    ],
    crypto: [
      {
        severity: 'info',
        title: '加密算法选择',
        description: '使用 AES-256-GCM 进行对称加密，RSA-2048+ 进行非对称加密',
        suggestion: '避免使用 DES、3DES、RC4 等弱加密算法',
      },
      {
        severity: 'info',
        title: '随机数生成',
        description: '安全场景使用 crypto.randomBytes() 而非 Math.random()',
        suggestion: 'crypto.randomBytes(32).toString("hex")',
      },
    ],
    secrets: [
      {
        severity: 'info',
        title: '密钥管理',
        description: '不要将密钥硬编码在源代码中',
        suggestion: '使用环境变量、密钥管理服务（如 AWS KMS、HashiCorp Vault）',
      },
      {
        severity: 'info',
        title: '.env 文件管理',
        description: '.env 文件不应提交到版本控制',
        suggestion: '在 .gitignore 中排除 .env*，提供 .env.example 模板',
      },
    ],
    deps: [
      {
        severity: 'info',
        title: '依赖安全',
        description: '定期检查依赖漏洞，使用 npm audit 或 osv_scan',
        suggestion: '在 CI/CD 中集成 npm audit --production',
      },
      {
        severity: 'info',
        title: '依赖锁定',
        description: '使用 lockfile 锁定依赖版本',
        suggestion: '提交 package-lock.json 到版本控制',
      },
    ],
  };

  const categories =
    category === 'all' ? Object.keys(allPractices) : [category];
  for (const cat of categories) {
    for (const item of allPractices[cat] || []) {
      practices.push({ ...item, category: cat });
    }
  }
  return practices;
}

export function createSecurityGuidanceExecutor(deps?: {
  projectRoot?: string;
}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const action = String(params.action || '');
    const directory = (params.directory as string) || '.';
    const category = String(params.category || 'all');
    const minSeverity = String(params.severity || 'warning');

    const projectRoot = path.isAbsolute(directory)
      ? directory
      : path.resolve(deps?.projectRoot || process.cwd(), directory);

    try {
      Logger.info(
        `🛡️ security_guidance ${action}: ${projectRoot}`,
        'SecurityGuidance'
      );

      let findings: SecurityFinding[] = [];

      switch (action) {
        case 'scan_secrets':
          findings = scanForSecrets(projectRoot, minSeverity);
          break;
        case 'audit_config':
          findings = [
            ...auditGitignore(projectRoot),
            ...auditEnvFiles(projectRoot),
          ];
          break;
        case 'best_practices':
          findings = getBestPractices(category);
          break;
        case 'check':
        default:
          findings = [
            ...scanForSecrets(projectRoot, minSeverity),
            ...auditGitignore(projectRoot),
            ...auditEnvFiles(projectRoot),
          ];
          break;
      }

      const minOrder = SEVERITY_ORDER[minSeverity] || 2;
      findings = findings.filter(
        (f) => (SEVERITY_ORDER[f.severity] || 1) >= minOrder
      );
      findings.sort(
        (a, b) =>
          (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0)
      );

      if (findings.length === 0) {
        return {
          success: true,
          output: '✅ 未发现安全问题',
          duration: Date.now() - startTime,
          validated: false,
          metadata: { findingsCount: 0 },
        };
      }

      const counts = {
        critical: findings.filter((f) => f.severity === 'critical').length,
        error: findings.filter((f) => f.severity === 'error').length,
        warning: findings.filter((f) => f.severity === 'warning').length,
        info: findings.filter((f) => f.severity === 'info').length,
      };

      const lines = [
        '🛡️ 安全检查报告',
        `📂 项目: ${projectRoot}`,
        '',
        `📊 发现: 🔴严重:${counts.critical} 🟠错误:${counts.error} ⚠️警告:${counts.warning} ℹ️信息:${counts.info}`,
        '',
      ];

      for (const f of findings.slice(0, 30)) {
        const icon = SEVERITY_ICON[f.severity] || '⚪';
        lines.push(`${icon} [${f.severity.toUpperCase()}] ${f.title}`);
        if (f.file) lines.push(`   📄 ${f.file}${f.line ? `:${f.line}` : ''}`);
        lines.push(`   ${f.description}`);
        lines.push(`   💡 ${f.suggestion}`);
        lines.push('');
      }

      if (findings.length > 30)
        lines.push(`... 还有 ${findings.length - 30} 个发现未显示`);
      if (counts.critical > 0) lines.push('🔴 存在严重安全问题，请立即修复！');

      Logger.info(
        `🛡️ security_guidance 完成: ${findings.length}个发现 (严重:${counts.critical})`,
        'SecurityGuidance'
      );

      return {
        success: true,
        output: lines.join('\n'),
        duration: Date.now() - startTime,
        validated: false,
        metadata: { findingsCount: findings.length, ...counts },
      };
    } catch (error) {
      Logger.error(
        '❌ security_guidance 失败',
        error as Error,
        'SecurityGuidance'
      );
      return {
        success: false,
        output: '',
        error: `安全检查失败: ${(error as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
