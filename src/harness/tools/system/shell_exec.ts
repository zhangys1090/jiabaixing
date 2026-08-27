import { spawn } from 'child_process';
import { getActivePythonBridge } from '../../../ide/bridgeRegistry';
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
  'rmdir /s /q',
  'rd /s /q',
  'shutdown',
  'reg delete',
  'reg add HKLM',
  'net user',
  'net localgroup',
  'cipher /w',
  'diskpart',
  'bcdedit',
  'taskkill /f /im svchost',
  'taskkill /f /im csrss',
  'taskkill /f /im lsass',
  'del /f /s /q',
  'erase /f /s /q',
  'cacls * /g everyone:f',
  'icacls * /grant everyone:f',
  'mklink /h',
  'fsutil',
  'vssadmin delete',
  'wbadmin delete',
  'powershell -enc',
  'powershell -encodedcommand',
  'pwsh -enc',
  'pwsh -encodedcommand',
  'certutil',
  'certutil -urlcache',
  'certutil -f',
  'bitsadmin',
  'bitsadmin /transfer',
  'bitsadmin /create',
  'cmd /c del',
  'cmd /c format',
  '> /dev/sda',
  'dd if=',
  'chmod -r 777 /',
  'chown -r',
  'kill -9 1',
  ':(){:|:&};:',
];

/** 危险命令检测结果 */
export interface DangerousCheck {
  blocked: boolean;
  reason: string;
}

/**
 * P0 禁令牌硬化: 对 shell 命令做 归一化 + 分词 + 危险令牌组合检测。
 *
 * 原实现仅在 `lowerCommand.includes(forbidden)` 上做子串匹配，可被以下变体绕过:
 *   - 标志拆分:   `rm -r -f /`        （`-r -f` 间多出空格，不含 `rm -rf /`）
 *   - 引号转义:   `rm"-rf" /`         （引号切断子串）
 *   - 多重空格:   `rm -rf  /`         （双空格）
 *
 * 本函数:
 *   1) 归一化（去引号/转义符→空格、折叠空白、转小写）后保留原 FORBIDDEN_COMMANDS 子串拦截
 *      —— 上述引号/空格变体在归一化后即被现有条目命中；
 *   2) 进一步分词，对命令名 + 危险标志组合 + 危险目标做结构化判定，覆盖标志拆分等子串
 *      检测不到的绕过。
 */
export function isShellCommandDangerous(rawCommand: string): DangerousCheck {
  if (!rawCommand || typeof rawCommand !== 'string') {
    return { blocked: false, reason: '' };
  }

  // 1) 归一化: 引号/反斜杠转义符 → 空格，折叠空白，转小写
  const normalized = rawCommand
    .replace(/["'`\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  // 1a) 保留原 FORBIDDEN_COMMANDS 子串拦截（在归一化串上，抗引号/多余空格绕过）
  for (const forbidden of FORBIDDEN_COMMANDS) {
    if (normalized.includes(forbidden.toLowerCase())) {
      return { blocked: true, reason: `包含禁止的操作 "${forbidden}"` };
    }
  }

  // 2) 分词 + 危险令牌组合
  const tokens = normalized.split(' ').filter(Boolean);
  const cmdName = tokens[0] || '';
  const nonFlag = tokens
    .slice(1)
    .filter((t) => !t.startsWith('-') && !t.startsWith('/'));
  const restJoined = tokens.slice(1).join(' ');

  // 危险命令名（整条命令即危险）
  const EXACT_DANGEROUS_CMDS = new Set([
    'format',
    'diskpart',
    'bcdedit',
    'cipher',
    'fsutil',
    'vssadmin',
    'wbadmin',
    'fdisk',
    'mkfs',
  ]);
  if (EXACT_DANGEROUS_CMDS.has(cmdName)) {
    return { blocked: true, reason: `禁止的命令: ${cmdName}` };
  }

  // 文件系统创建命令（含 mkfs.ext4 / mkfs.vfat 等变体）一律拦截
  if (cmdName === 'mkfs' || cmdName.startsWith('mkfs.')) {
    return { blocked: true, reason: `禁止的文件系统创建命令: ${cmdName}` };
  }

  // 系统电源/重启命令精确判定：
  //   拦截 reboot / restart(裸) / halt / poweroff / shutdown（均为整机电源操作）；
  //   放行服务重启（systemctl restart <svc> / sc restart <svc> / service <svc> restart），
  //   因其命令名分别是 systemctl / sc / service，不会命中本分支。
  if (
    cmdName === 'reboot' ||
    cmdName === 'restart' ||
    cmdName === 'halt' ||
    cmdName === 'poweroff' ||
    cmdName === 'shutdown'
  ) {
    return {
      blocked: true,
      reason: `禁止系统电源/重启命令: ${cmdName}`,
    };
  }

  // 编码执行的 PowerShell / cmd /c
  if (
    (cmdName === 'powershell' || cmdName === 'pwsh') &&
    tokens.some(
      (t) => t === '-enc' || t === '-encodedcommand' || t.startsWith('-enc:')
    )
  ) {
    return {
      blocked: true,
      reason: '禁止编码执行的 PowerShell 命令 (-enc/-encodedcommand)',
    };
  }
  if (cmdName === 'cmd' && tokens.includes('/c')) {
    const rest = tokens.slice(tokens.indexOf('/c') + 1).join(' ');
    if (/\b(del|format|rmdir|rd)\b/.test(rest)) {
      return { blocked: true, reason: '禁止通过 cmd /c 执行删除/格式化命令' };
    }
  }

  // 递归删除危险目标（rm/rmdir/rd/del/erase + 递归标志 + 根/通配/盘符/家目录）
  const destructive = new Set(['rm', 'rmdir', 'rd', 'del', 'erase']);
  const RM_FLAGS = new Set(['-r', '-rf', '-fr', '-R', '-f']);
  const WIN_FLAGS = new Set(['/s', '/q', '/s/q', '/q/s']);
  const ALL_RM_FLAGS = new Set([...RM_FLAGS, ...WIN_FLAGS]);
  const RECURSIVE_SUBSET = new Set([
    '-r',
    '-rf',
    '-fr',
    '-R',
    '/s',
    '/q',
    '/s/q',
    '/q/s',
  ]);
  if (destructive.has(cmdName)) {
    const hasRecursive = tokens.some((t) => RECURSIVE_SUBSET.has(t));
    // 先剔除全部 rm 标志（含 -f 强制），再对剩余目标令牌做危险判定
    const targetTokens = tokens.slice(1).filter((t) => !ALL_RM_FLAGS.has(t));
    const targetStr = targetTokens.join(' ');
    const hitsRootOrWild =
      targetStr === '/' ||
      targetStr === '.' ||
      targetStr.startsWith('/') ||
      targetStr.includes('/*') ||
      targetStr.includes('c:\\') ||
      targetStr.includes('c:/') ||
      /[a-z]:[\\/]/i.test(targetStr) ||
      targetStr.includes('~') ||
      targetStr === '*' ||
      targetStr.endsWith('/*');
    if (hasRecursive && hitsRootOrWild) {
      return { blocked: true, reason: `递归删除危险目标: ${restJoined}` };
    }
  }

  // chmod / chown 递归 + 777 / 根目录
  if (cmdName === 'chmod' || cmdName === 'chown') {
    const hasRecursive = tokens.some((t) => t === '-r' || t === '-R');
    const targetTokens = tokens
      .slice(1)
      .filter((t) => t !== '-r' && t !== '-R');
    const hitsRoot = targetTokens.some(
      (t) =>
        t === '/' ||
        t === '.' ||
        t.startsWith('/') ||
        /^[a-z]:[\\/]/i.test(t) ||
        t.includes('~')
    );
    if ((hasRecursive && restJoined.includes('777')) || hitsRoot) {
      return { blocked: true, reason: `危险的权限变更: ${restJoined}` };
    }
  }

  // taskkill 强制结束系统进程 / kill -9 1
  if (cmdName === 'taskkill' && tokens.includes('/f')) {
    const idx = tokens.indexOf('/im');
    const sysProcs = [
      'svchost',
      'csrss',
      'lsass',
      'wininit',
      'services',
      'lsass.exe',
    ];
    if (idx >= 0 && sysProcs.includes(tokens[idx + 1])) {
      return { blocked: true, reason: '禁止强制结束系统关键进程' };
    }
    if (tokens.includes('/pid') && tokens.includes('1')) {
      return { blocked: true, reason: '禁止强制结束 PID 1' };
    }
  }
  if (cmdName === 'kill' && tokens.includes('-9') && tokens.includes('1')) {
    return { blocked: true, reason: '禁止 kill -9 1' };
  }

  // 注册表 / 网络账户 / 全员授权 / 硬链接
  if (
    cmdName === 'reg' &&
    (tokens.includes('delete') ||
      (tokens.includes('add') && tokens.includes('hklm')))
  ) {
    return { blocked: true, reason: '禁止危险的注册表操作' };
  }
  if (
    cmdName === 'net' &&
    (tokens.includes('user') || tokens.includes('localgroup'))
  ) {
    return { blocked: true, reason: '禁止 net user / net localgroup 操作' };
  }
  if (
    (cmdName === 'cacls' || cmdName === 'icacls') &&
    (tokens.includes('*') || normalized.includes('everyone'))
  ) {
    return { blocked: true, reason: '禁止向所有人授予权限' };
  }
  if (cmdName === 'mklink' && tokens.includes('/h')) {
    return { blocked: true, reason: '禁止 mklink /h 硬链接' };
  }

  return { blocked: false, reason: '' };
}

export interface ShellExecDeps {
  shellRunner?: (
    command: string,
    options: {
      timeout: number;
      cwd?: string;
    }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** 多环境终端后端（优先于 shellRunner 和 spawn 回退） */
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

/**
 * P0-③ 超时取消修复: 用 spawn 真正异步执行，并在超时时 kill 子进程。
 *
 * 原实现使用 execSync（同步阻塞事件循环）。即便 execSync 自带 timeout 选项会在超时后
 * 杀掉子进程并抛错，其同步特性仍会阻塞整个 Node 事件循环，使 ToolRegistry 的
 * Promise.race 超时无法抢占其它并发请求。本实现改为 spawn 异步执行，超时时先发
 * SIGTERM 再在 500ms 后发 SIGKILL，确保挂起命令被真正取消，且不再阻塞事件循环。
 *
 * 注: 在 Windows 上 shell:true 的 spawn 子进程为 cmd.exe；kill 会终止该 shell，
 * 正常情况下由其衍生的命令也随之结束。极端情况下由 shell 另起的独立子进程可能残留，
 * 但已满足“取消挂起命令”的核心目标。
 */
function runSpawn(
  command: string,
  timeout: number,
  cwd?: string
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => {
      if (!timedOut) stdout += d;
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (d: string) => {
      if (!timedOut) stderr += d;
    });

    timer = setTimeout(() => {
      timedOut = true;
      // 先优雅终止，500ms 后强制杀死，确保挂起进程被取消
      try {
        child.kill('SIGTERM');
      } catch {
        /* 进程可能已退出 */
      }
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
      }, 500);
    }, timeout);

    child.on('error', (err) => {
      stderr += err.message;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    // 兜底：close 未触发时（极少数情况）用 exit 收尾
    child.on('exit', (code) => finish(code ?? -1));
  });
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

    return await llm.chat(
      prompt,
      [],
      '你是家百星的命令行输出解读模块。简洁回答。'
    );
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

    // Fork bomb 模式检测（bash fork bomb 的各种变体）
    if (
      command.match(/\(\)\s*\{[\s\S]*\|\s*&[\s\S]*\}\s*;/) ||
      command.includes(':(){')
    ) {
      Logger.warn(
        `🛡️ shell_exec 拦截 fork bomb: "${command.substring(0, 50)}"`,
        'ShellExec'
      );
      return fail(
        '命令被安全策略拦截: 检测到 fork bomb 模式',
        Date.now() - startTime
      );
    }

    // 管道重定向到设备文件检测
    if (command.match(/>\s*\/dev\/(sda|hda|sd[a-z]|nvme)/)) {
      Logger.warn(
        `🛡️ shell_exec 拦截设备写入: "${command.substring(0, 50)}"`,
        'ShellExec'
      );
      return fail(
        '命令被安全策略拦截: 检测到向块设备写入的重定向',
        Date.now() - startTime
      );
    }

    try {
      // P0 禁令牌硬化: 归一化 + 分词 + 危险令牌组合检测（覆盖引号/空格/标志拆分绕过）
      const danger = isShellCommandDangerous(command);
      if (danger.blocked) {
        Logger.warn(
          `🛡️ shell_exec 拦截危险命令: ${danger.reason} — "${command}"`,
          'ShellExec'
        );
        return fail(
          `命令被安全策略拦截: ${danger.reason}`,
          Date.now() - startTime
        );
      }

      // F1 (Phase1): shell_exec 归 Python canonical —— 经 PythonAgentBridge 代理到
      // Python POST /api/tools/execute(shell_exec)。Python 端为白名单+沙箱 fail-closed+
      // subprocess(shell=False), 比 TS 本地 shell:true 更严格(消除 shell 注入面)。
      // 仅当 Python 桥可用时代理; Python 逻辑拒绝(含安全违规)直接诚实返回, 绝不回退
      // 到更宽松的 TS 本地执行; 仅 transport 错误才安全降级本地(safe-degrade, 对齐 §0.1)。
      const bridgeForShell = getActivePythonBridge();
      if (bridgeForShell) {
        try {
          const pyRes = await bridgeForShell.toolsetExecuteRaw('shell_exec', {
            command,
            timeout,
            cwd,
          });
          const duration = Date.now() - startTime;
          if (pyRes?.success) {
            let finalOutput = String(pyRes.output ?? '').substring(0, 10000);
            if (interpret && deps.llm) {
              const interp = await interpretOutput(
                deps.llm,
                command,
                String(pyRes.output ?? '')
              );
              if (interp) finalOutput += `\n\n📖 解读:\n${interp}`;
            }
            return ok(finalOutput, duration, {
              ...(pyRes.metadata || {}),
              command,
              backend: 'python',
            });
          }
          // Python 逻辑拒绝(含安全违规): 诚实返回, 不回退本地
          return fail(
            pyRes?.error || 'Python shell_exec 执行失败',
            duration,
            String(pyRes?.output ?? '').substring(0, 5000)
          );
        } catch (pyErr) {
          // 仅 transport 错误才安全降级到 TS 本地执行
          Logger.warn(
            `⚠️ F1 shell_exec Python 代理传输失败, 降级本地: ${(pyErr as Error).message}`,
            'ShellExec'
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

      const { stdout, stderr, exitCode, timedOut } = await runSpawn(
        command,
        timeout,
        cwd
      );

      if (timedOut) {
        Logger.warn(
          `⏱️ shell_exec 超时已取消: "${command.substring(0, 50)}"`,
          'ShellExec'
        );
        return fail(
          `命令执行超时（>${timeout}ms）已被取消`,
          Date.now() - startTime,
          (stdout + stderr).substring(0, 5000)
        );
      }

      if (exitCode !== 0) {
        return fail(
          `命令退出码: ${exitCode}`,
          Date.now() - startTime,
          (stdout || stderr || '').substring(0, 5000)
        );
      }

      Logger.info(
        `⚡ shell_exec 成功: "${command.substring(0, 50)}"`,
        'ShellExec'
      );

      const output = stdout || stderr || '(无输出)';
      let finalOutput = output.substring(0, 10000);
      if (interpret && deps.llm) {
        const interp = await interpretOutput(deps.llm, command, output);
        if (interp) finalOutput += `\n\n📖 解读:\n${interp}`;
      }

      return ok(finalOutput, Date.now() - startTime, { exitCode, command });
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
