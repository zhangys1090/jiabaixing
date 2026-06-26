import { execSync } from 'child_process';
import { Logger } from '../../../utils/Logger';
import type { ITerminalBackend } from '../../sandbox/backends/ITerminalBackend';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const SHELL_EXEC_DEF: ToolDefinition = {
  name: 'shell_exec',
  description:
    'Shell命令执行工具。在系统终端中执行命令并返回输出。适用场景：运行脚本、管理系统、安装依赖。不适用：需要交互式输入的命令。设置 interpret=true 可让 AI 解读命令输出。',
  category: ToolCategory.SYSTEM,
  parameters: {
    command: {
      type: 'string',
      description: '要执行的命令',
    },
    timeout: {
      type: 'number',
      description: '超时时间（毫秒）',
      default: 30000,
    },
    cwd: {
      type: 'string',
      description: '工作目录（可选）',
    },
    interpret: {
      type: 'boolean',
      description: '是否让 AI 解读命令输出结果',
      default: false,
    },
  },
  requiredParams: ['command'],
  requiredPermissions: [Permission.SYSTEM_ADMIN],
  riskLevel: 'high',
  idempotent: false,
  timeout: 35000,
};

const FORBIDDEN_COMMANDS = [
  'format',
  'del /s /q C:',
  'rm -rf /',
  'rm -rf /*',
  'shutdown',
  'restart',
  'reg delete',
  'reg add HKLM',
  'net user',
  'net localgroup',
  'cipher /w',
  'diskpart',
  'bcdedit',
  'taskkill /f /im svchost',
];

export interface ShellExecDeps {
  shellRunner?: (
    command: string,
    options: {
      timeout: number;
      cwd?: string;
    }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 多环境终端后端（优先于 shellRunner 和 execSync） */
  terminalBackend?: ITerminalBackend;
  llm?: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  };
}

function ok(
  output: string,
  duration: number,
  metadata?: Record<string, unknown>
): ToolResult {
  return { success: true, output, duration, validated: false, metadata };
}

function fail(
  error: string,
  duration: number,
  output: string = ''
): ToolResult {
  return { success: false, output, error, duration, validated: false };
}

async function interpretOutput(
  llm: {
    chat(
      prompt: string,
      history?: unknown[],
      systemPrompt?: string
    ): Promise<string>;
  },
  command: string,
  output: string
): Promise<string> {
  try {
    const prompt = `以下是命令执行的输出结果，请用简洁的中文解读关键信息。

命令: ${command}
输出:
\`\`\`
${output.substring(0, 3000)}
\`\`\`

要求:
1. 用 1-3 句话总结关键信息
2. 如果是错误，指出原因和建议
3. 如果是列表/表格，提取最重要的几项
4. 不要重复原始输出`;

    return await llm.chat(prompt, [], '你是一个命令行输出解读专家。简洁回答。');
  } catch {
    return '';
  }
}

export function createShellExecExecutor(deps: ShellExecDeps = {}) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const command = params.command as string;
    const timeout = (params.timeout as number) || 30000;
    let cwd = params.cwd as string | undefined;
    const interpret = params.interpret === true;

    // 中文命令检测：纯中文开头的命令在系统终端无法执行
    if (command && /^[\u4e00-\u9fff]/.test(command.trim())) {
      // 允许包含中文但以合法命令开头的混合命令（如 echo "中文"）
      const commandPart = command.trim().split(/\s+/)[0];
      const knownCommands =
        /^(npm|node|python|python3|git|docker|echo|ls|cat|cd|mkdir|rm|cp|mv|curl|wget|ping|ipconfig|netstat|dir|type|findstr|java|go|rustc|cargo|make|gcc|g\+\+|clang|dotnet|ruby|php|perl|bash|sh|zsh|powershell|cmd|winget|choco|scoop|pip|conda|yarn|pnpm|npx|tsc|eslint|prettier|jest|mocha)/i;
      if (!knownCommands.test(commandPart)) {
        Logger.warn(
          `🛡️ shell_exec 拦截中文命令: "${command.substring(0, 50)}"`,
          'ShellExec'
        );
        return fail(
          `命令以中文开头，不是有效的系统命令: "${command.substring(0, 50)}"。如需执行系统命令，请使用英文命令名，如 "dir" 或 "ping baidu.com"。如需AI帮助，请直接描述你的需求。`,
          Date.now() - startTime
        );
      }
    }

    // Windows 路径兼容：将 /tmp/ 转换为 Windows 临时目录
    if (cwd && /^\/tmp\//.test(cwd)) {
      const os = await import('os');
      cwd = cwd.replace(/^\/tmp\//, os.tmpdir().replace(/\\/g, '/') + '/');
      Logger.info(`🔧 路径标准化: /tmp/ → ${cwd}`, 'ShellExec');
    }

    try {
      const lowerCommand = command.toLowerCase().trim();
      for (const forbidden of FORBIDDEN_COMMANDS) {
        if (lowerCommand.includes(forbidden.toLowerCase())) {
          Logger.warn(`🛡️ shell_exec 拦截危险命令: "${command}"`, 'ShellExec');
          return fail(
            `命令被安全策略拦截: 包含禁止的操作 "${forbidden}"`,
            Date.now() - startTime
          );
        }
      }

      if (deps.terminalBackend) {
        const result = await deps.terminalBackend.execute(command, {
          timeout,
          cwd,
        });
        const output = result.stdout || result.stderr || '(无输出)';
        if (result.success) {
          let finalOutput = output.substring(0, 10000);
          if (interpret && deps.llm) {
            const interp = await interpretOutput(deps.llm, command, output);
            if (interp) finalOutput += `\n\n📖 解读:\n${interp}`;
          }
          return ok(finalOutput, Date.now() - startTime, {
            exitCode: result.exitCode,
            command,
            backend: result.backend,
          });
        }
        return fail(
          `命令退出码: ${result.exitCode}`,
          Date.now() - startTime,
          output.substring(0, 5000)
        );
      }

      if (deps.shellRunner) {
        const result = await deps.shellRunner(command, { timeout, cwd });
        const output = result.stdout || result.stderr || '(无输出)';
        if (result.exitCode === 0) {
          let finalOutput = output.substring(0, 10000);
          if (interpret && deps.llm) {
            const interp = await interpretOutput(deps.llm, command, output);
            if (interp) finalOutput += `\n\n📖 解读:\n${interp}`;
          }
          return ok(finalOutput, Date.now() - startTime, {
            exitCode: 0,
            command,
          });
        }
        return fail(
          `命令退出码: ${result.exitCode}`,
          Date.now() - startTime,
          output.substring(0, 5000)
        );
      }

      const result = execSync(command, {
        encoding: 'utf-8',
        timeout,
        cwd: cwd || process.cwd(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });

      Logger.info(
        `⚡ shell_exec 成功: "${command.substring(0, 50)}"`,
        'ShellExec'
      );

      let finalOutput = (result || '(无输出)').substring(0, 10000);
      if (interpret && deps.llm) {
        const interp = await interpretOutput(deps.llm, command, result);
        if (interp) finalOutput += `\n\n📖 解读:\n${interp}`;
      }

      return ok(finalOutput, Date.now() - startTime, { exitCode: 0, command });
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      const output = err.stdout || err.stderr || err.message || '执行失败';

      Logger.warn(
        `⚠️ shell_exec 失败: "${command.substring(0, 50)}"`,
        'ShellExec'
      );

      return fail(
        `命令执行失败 (exit code: ${err.status || 1}): ${err.message.substring(0, 200)}`,
        Date.now() - startTime,
        output.substring(0, 5000)
      );
    }
  };
}
