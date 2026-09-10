/**
 * 代码审查工具 — 多维度代码审查
 *
 * 实际能力（如实描述，避免夸大）：
 * - 规则检查(质量/风格)：console.log / any / 空 catch / 文件过长
 * - 安全模式扫描：硬编码密钥 / SQL 注入 / eval / innerHTML / 原型链污染 / document.write
 * - 可选 LLM 逻辑审查（超 10000 字符自动跳过；失败如实记录）
 * - 返回结构化审查报告
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const CODE_REVIEW_DEF: ToolDefinition = {
  name: 'code_review',
  description:
    '审查代码文件，从规则检查(质量/风格)、安全模式扫描、可选 LLM 逻辑审查三个层面发现问题。USE WHEN: 用户要求代码审查、找bug、安全检查、代码质量分析。DO NOT USE WHEN: 用户要修改代码（用code_fix）或生成新代码（用code_generate）。返回结构化审查报告（注：非真实语法树/性能剖析，仅模式匹配 + 可选 LLM）。',
  category: ToolCategory.CODE,
  parameters: {
    file_path: {
      type: 'string',
      description: '要审查的文件路径',
    },
    focus: {
      type: 'string',
      description: '审查重点',
      enum: ['all', 'security', 'performance', 'quality'],
      default: 'all',
    },
  },
  requiredParams: ['file_path'],
  requiredPermissions: [Permission.FILE_READ, Permission.CODE_EXECUTE],
  riskLevel: 'low',
  idempotent: true,
  timeout: 60000,
};

export interface CodeReviewDeps {
  llm?: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  };
}

interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: 'security' | 'performance' | 'quality' | 'style';
  line?: number;
  message: string;
  suggestion: string;
}

export function createCodeReviewExecutor(deps: CodeReviewDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const filePath = String(params.file_path || '');
    const focus = String(params.focus || 'all');

    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          output: null,
          error: `文件不存在: ${filePath}`,
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();
      const lines = content.split('\n');

      // Layer 1: 规则检查（快速，不需要 LLM）
      const ruleFindings = runRuleChecks(content, lines, ext);

      // Layer 2: 安全检查（模式匹配）
      const securityFindings = runSecurityChecks(content, lines);

      // Layer 3: LLM 逻辑审查（如果可用）
      let llmFindings: ReviewFinding[] = [];
      let llmSkipped = false;
      let llmFailed = false;
      if (deps.llm && content.length < 10000) {
        try {
          llmFindings = await runLLMReview(deps.llm, content, filePath, focus);
        } catch (llmErr) {
          // LLM 审查失败不再静默吞：记录日志并在报告/metadata 中如实呈现
          llmFailed = true;
          Logger.warn(
            `⚠️ code_review LLM 逻辑审查失败，仅返回规则检查+安全扫描: ${(llmErr as Error).message}`,
            'CodeReview'
          );
        }
      } else if (deps.llm && content.length >= 10000) {
        llmSkipped = true;
      }

      // 合并结果
      const allFindings = [
        ...ruleFindings,
        ...securityFindings,
        ...llmFindings,
      ];

      // 按严重度排序
      const severityOrder = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
        info: 4,
      };
      allFindings.sort(
        (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
      );

      // 格式化输出
      let output = formatReviewReport(
        filePath,
        lines.length,
        allFindings,
        focus
      );

      if (llmSkipped) {
        output +=
          '\n\n[LLM审查已跳过: 文件超过10000字符，仅执行规则检查和安全扫描]';
      }
      if (llmFailed) {
        output +=
          '\n\n[LLM审查失败: 逻辑审查未执行，仅返回规则检查和安全扫描结果]';
      }

      return {
        success: true,
        output,
        duration: Date.now() - startTime,
        validated: true,
        metadata: {
          filePath,
          totalLines: lines.length,
          findingsCount: allFindings.length,
          criticalCount: allFindings.filter((f) => f.severity === 'critical')
            .length,
          highCount: allFindings.filter((f) => f.severity === 'high').length,
          llmSkipped,
          llmFailed,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `代码审查失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}

function runRuleChecks(
  content: string,
  lines: string[],
  ext: string
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // 检查 console.log（生产代码）
  if (ext === '.ts' || ext === '.js') {
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].includes('console.log') &&
        !lines[i].trim().startsWith('//')
      ) {
        findings.push({
          severity: 'low',
          category: 'quality',
          line: i + 1,
          message: '生产代码中包含 console.log',
          suggestion: '使用 Logger 替代或移除',
        });
      }
    }

    // 检查 any 类型
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(': any') && !lines[i].trim().startsWith('//')) {
        findings.push({
          severity: 'low',
          category: 'quality',
          line: i + 1,
          message: '使用了 any 类型',
          suggestion: '考虑使用更具体的类型定义',
        });
      }
    }

    // 检查空 catch
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/)) {
        findings.push({
          severity: 'medium',
          category: 'quality',
          line: i + 1,
          message: '空的 catch 块，错误被静默吞没',
          suggestion: '至少记录错误日志: Logger.warn(...)',
        });
      }
    }
  }

  // 检查文件过长
  if (lines.length > 500) {
    findings.push({
      severity: 'low',
      category: 'quality',
      message: `文件过长 (${lines.length} 行)`,
      suggestion: '考虑拆分为更小的模块',
    });
  }

  return findings.slice(0, 20); // 限制返回数量
}

function runSecurityChecks(content: string, lines: string[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // 检查硬编码密钥
  const secretPatterns = [
    {
      pattern:
        /(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
      name: '硬编码密钥',
    },
    { pattern: /(?:sk-|api_)[a-zA-Z0-9]{20,}/g, name: 'API密钥' },
  ];

  for (const { pattern, name } of secretPatterns) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]) && !lines[i].trim().startsWith('//')) {
        findings.push({
          severity: 'critical',
          category: 'security',
          line: i + 1,
          message: `检测到${name}`,
          suggestion: '使用环境变量替代硬编码密钥',
        });
      }
    }
  }

  // 检查 SQL 注入风险
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/query\(.*\$\{/i) && !lines[i].trim().startsWith('//')) {
      findings.push({
        severity: 'high',
        category: 'security',
        line: i + 1,
        message: '可能存在 SQL 注入风险（模板字符串拼接）',
        suggestion: '使用参数化查询',
      });
    }
  }

  // 检查 eval 使用
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/\beval\s*\(/) && !lines[i].trim().startsWith('//')) {
      findings.push({
        severity: 'high',
        category: 'security',
        line: i + 1,
        message: '使用了 eval()，存在代码注入风险',
        suggestion: '避免使用 eval，考虑替代方案',
      });
    }
  }

  // 检查 innerHTML 注入风险
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].match(/\.innerHTML\s*[+=]/) &&
      !lines[i].trim().startsWith('//')
    ) {
      findings.push({
        severity: 'high',
        category: 'security',
        line: i + 1,
        message: '使用 innerHTML 赋值，存在 XSS 注入风险',
        suggestion: '使用 textContent 或 DOMPurify.sanitize() 替代',
      });
    }
  }

  // 检查 prototype pollution 风险
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].match(/__proto__|constructor\s*\[\s*['"]prototype['"]\s*\]/) &&
      !lines[i].trim().startsWith('//')
    ) {
      findings.push({
        severity: 'high',
        category: 'security',
        line: i + 1,
        message: '可能存在原型链污染风险',
        suggestion: '避免直接操作 __proto__，使用 Object.create()',
      });
    }
  }

  // 检查 document.write 风险
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].match(/document\.write\s*\(/) &&
      !lines[i].trim().startsWith('//')
    ) {
      findings.push({
        severity: 'medium',
        category: 'security',
        line: i + 1,
        message: '使用 document.write()，存在 XSS 风险且影响性能',
        suggestion: '使用 DOM API（createElement/appendChild）替代',
      });
    }
  }

  return findings.slice(0, 20);
}

async function runLLMReview(
  llm: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  },
  content: string,
  filePath: string,
  focus: string
): Promise<ReviewFinding[]> {
  const prompt = `审查以下代码文件，找出问题。

文件: ${filePath}
审查重点: ${focus}

代码:
\`\`\`
${content.substring(0, 6000)}
\`\`\`

请用 JSON 数组格式输出发现的问题:
[{"severity": "critical|high|medium|low|info", "category": "security|performance|quality|style", "line": 行号, "message": "问题描述", "suggestion": "修复建议"}]

只输出 JSON，不要其他内容。最多输出 5 个最重要的问题。`;

  const response = await llm.chat(
    prompt,
    [],
    '你是家百星的代码审查模块。只输出 JSON 数组。'
  );

  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as ReviewFinding[];
    }
  } catch {
    // JSON 解析失败
  }
  return [];
}

function formatReviewReport(
  filePath: string,
  totalLines: number,
  findings: ReviewFinding[],
  focus: string
): string {
  const lines: string[] = [];
  lines.push(`📋 代码审查报告: ${filePath}`);
  lines.push(`总行数: ${totalLines} | 审查重点: ${focus}`);
  lines.push(`发现问题: ${findings.length} 个`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('✅ 未发现问题，代码质量良好。');
    return lines.join('\n');
  }

  const critical = findings.filter((f) => f.severity === 'critical');
  const high = findings.filter((f) => f.severity === 'high');
  const medium = findings.filter((f) => f.severity === 'medium');
  const low = findings.filter((f) => f.severity === 'low');

  if (critical.length > 0) lines.push(`🔴 严重: ${critical.length}`);
  if (high.length > 0) lines.push(`🟠 高危: ${high.length}`);
  if (medium.length > 0) lines.push(`🟡 中等: ${medium.length}`);
  if (low.length > 0) lines.push(`🟢 低危: ${low.length}`);
  lines.push('');

  for (const finding of findings) {
    const icon = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢',
      info: 'ℹ️',
    }[finding.severity];
    const lineRef = finding.line ? ` (行 ${finding.line})` : '';
    lines.push(`${icon} [${finding.category}]${lineRef} ${finding.message}`);
    lines.push(`   建议: ${finding.suggestion}`);
    lines.push('');
  }

  return lines.join('\n');
}
