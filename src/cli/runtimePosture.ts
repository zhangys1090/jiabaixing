/**
 * CLI 运行时安全姿态标志解析（纯函数，无重依赖，便于单测）。
 *
 * TS 层仅做入口透传：把 --safe-mode/--yolo/--auto/--posture 映射为
 * 环境变量 AGENT_RUNTIME_POSTURE，真正裁决在 Python 后端
 * （agent/security/runtime_posture.py）。符合 AGENTS.md §0.1 模块归属。
 */

/** 合法的运行时安全姿态取值（与 Python RuntimePosture 对齐）。 */
export const RUNTIME_POSTURES = ['safe', 'confirm', 'auto', 'yolo'] as const;
export type RuntimePosture = (typeof RUNTIME_POSTURES)[number];

/**
 * 解析 CLI 全局安全姿态标志。
 *
 * 支持：--safe-mode / --yolo / --auto(=--accept-hooks) / --posture <v> / --posture=<v>
 * 后出现的标志覆盖先出现的。非法 --posture 取值被忽略。
 *
 * @param args - 原始命令行参数
 * @returns posture（未指定为 null）与剔除姿态标志后的 rest 参数
 */
export function parseRuntimePostureFlags(args: string[]): {
  posture: RuntimePosture | null;
  rest: string[];
} {
  let posture: RuntimePosture | null = null;
  const rest: string[] = [];

  const setPosture = (value: string): void => {
    const v = value.trim().toLowerCase();
    if ((RUNTIME_POSTURES as readonly string[]).includes(v)) {
      posture = v as RuntimePosture;
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--safe-mode') {
      posture = 'safe';
    } else if (arg === '--yolo') {
      posture = 'yolo';
    } else if (arg === '--auto' || arg === '--accept-hooks') {
      posture = 'auto';
    } else if (arg === '--posture') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        setPosture(next);
        i++;
      }
    } else if (arg.startsWith('--posture=')) {
      setPosture(arg.slice('--posture='.length));
    } else {
      rest.push(arg);
    }
  }

  return { posture, rest };
}

/**
 * 应用安全姿态标志：写入 process.env.AGENT_RUNTIME_POSTURE 并返回剔除后的参数。
 * 仅当显式指定时才写 env，未指定则保持默认（Python 侧回退 confirm）。
 */
export function applyRuntimePostureFlags(args: string[]): string[] {
  const { posture, rest } = parseRuntimePostureFlags(args);
  if (posture) {
    process.env.AGENT_RUNTIME_POSTURE = posture;
  }
  return rest;
}
