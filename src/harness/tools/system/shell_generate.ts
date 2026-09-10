/**
 * 自然语言 → Shell 命令工具
 *
 * 学习 CLI-Anything / OpenCLI 理念：
 * - 用户描述意图，LLM 生成适合当前 OS 的命令
 * - 自动检测操作系统
 * - 评估命令风险等级
 */

import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const SHELL_GENERATE_DEF: ToolDefinition = {
  name: 'shell_generate',
  description:
    '将自然语言描述转换为 Shell 命令。USE WHEN: 用户用自然语言描述想做什么（如"查看端口占用"、"找大文件"、"清理缓存"），而不是给出具体命令。DO NOT USE WHEN: 用户已经给出了具体命令（用 shell_exec）。自动适配 Windows/Linux/macOS。',
  category: ToolCategory.SYSTEM,
  parameters: {
    intent: {
      type: 'string',
      description: '用户意图的自然语言描述，如"查看8080端口被谁占用"',
    },
    os: {
      type: 'string',
      description: '目标操作系统，可选 win32/linux/darwin，默认自动检测',
    },
  },
  requiredParams: ['intent'],
  requiredPermissions: [Permission.SYSTEM_ADMIN],
  riskLevel: 'medium',
  idempotent: true,
  timeout: 30000,
};

export interface ShellGenerateDeps {
  llm?: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  };
}

// 低风险命令模式 — 不需要用户确认
const LOW_RISK_PATTERNS = [
  /^(ls|dir|Get-ChildItem|pwd|cd|echo|cat|Get-Content|head|tail|wc|grep|find|which|where|whoami|hostname|date|uname|ver|env|set)/i,
  /^(ipconfig|ifconfig|ping|traceroute|nslookup|netstat|systeminfo|tasklist)/i,
  /^(git\s+(status|log|diff|branch|show|remote))/i,
  /^(npm\s+(list|ls|outdated|whoami|prefix))/i,
  /^(node\s+--version|python\s+--version|java\s+-version)/i,
];

function detectOS(): string {
  const platform = process.platform;
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function getOSName(os: string): string {
  switch (os) {
    case 'win32':
      return 'Windows (PowerShell)';
    case 'darwin':
      return 'macOS (zsh/bash)';
    case 'linux':
      return 'Linux (bash)';
    default:
      return os;
  }
}

function isLowRisk(command: string): boolean {
  const trimmed = command.trim();
  return LOW_RISK_PATTERNS.some((p) => p.test(trimmed));
}

export function createShellGenerateExecutor(deps: ShellGenerateDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const intent = String(params.intent || '');
    const os = String(params.os || detectOS());

    if (!intent.trim()) {
      return {
        success: false,
        output: null,
        error: '意图描述不能为空',
        duration: Date.now() - startTime,
        validated: false,
      };
    }

    // 无 LLM 时返回模板化建议
    if (!deps.llm) {
      return {
        success: true,
        output: `⚠️ 无 LLM 可用，无法生成命令。\n\n意图: ${intent}\n系统: ${getOSName(os)}\n\n请手动输入对应命令，或使用 shell_exec 直接执行。`,
        duration: Date.now() - startTime,
        validated: true,
        metadata: { fallback: true, intent, os },
      };
    }

    try {
      const osName = getOSName(os);
      const prompt = `你是家百星的命令行助手。用户想完成以下操作，请生成对应的 shell 命令。

用户意图: ${intent}
操作系统: ${osName}

请严格按以下 JSON 格式输出（不要输出其他内容）:
{
  "command": "实际命令",
  "explanation": "一句话解释这个命令做了什么",
  "risk_level": "low|medium|high",
  "requires_confirm": true或false
}

规则:
1. 命令必须适配指定的操作系统
2. Windows 用 PowerShell 语法，Linux/macOS 用 bash 语法
3. 如果意图模糊，给出最安全的命令
4. 高风险命令（删除文件、修改系统、网络请求等）requires_confirm 设为 true
5. 只输出 JSON，不要其他内容`;

      const response = await deps.llm.chat(
        prompt,
        [],
        '你是家百星的命令行助手，只输出 JSON。'
      );

      // 解析 LLM 返回的 JSON
      let parsed: {
        command: string;
        explanation: string;
        risk_level: string;
        requires_confirm: boolean;
      };

      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('LLM 未返回有效 JSON');
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return {
          success: false,
          output: null,
          error: 'LLM 返回格式异常，请重试',
          duration: Date.now() - startTime,
          validated: false,
        };
      }

      const { command, explanation, risk_level } = parsed;
      const lowRisk = isLowRisk(command);
      const needsConfirm =
        !lowRisk && (risk_level === 'high' || risk_level === 'medium');

      const icon = { low: '🟢', medium: '🟡', high: '🔴' }[risk_level] || '⚪';

      const output = [
        `💻 生成命令 (${osName})`,
        ``,
        `$ ${command}`,
        ``,
        `${icon} 风险: ${risk_level}`,
        `📖 ${explanation}`,
        needsConfirm
          ? `\n⚠️ 此命令需要确认后执行。使用 shell_exec 执行: ${command}`
          : '',
      ].join('\n');

      Logger.info(
        `💻 shell_generate: "${intent}" → "${command}"`,
        'ShellGenerate'
      );

      return {
        success: true,
        output,
        duration: Date.now() - startTime,
        validated: true,
        needsConfirmation: needsConfirm,
        metadata: {
          command,
          explanation,
          risk_level,
          os,
          intent,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: `命令生成失败: ${(err as Error).message}`,
        duration: Date.now() - startTime,
        validated: false,
      };
    }
  };
}
