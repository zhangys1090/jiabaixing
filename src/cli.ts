/**
 * CLI 薄代理入口
 *
 * 所有逻辑已迁移到 src/cli/ 模块化目录：
 *   - src/cli/index.ts    → 公共 API 导出
 *   - src/cli/repl.ts     → REPL 交互循环
 *   - src/cli/ipc.ts      → IPC/HTTP 通信层
 *   - src/cli/constants.ts → 常量、颜色、横幅
 *   - src/cli/utils.ts    → 工具函数
 *   - src/cli/types.ts    → 共享类型
 *   - src/cli/commands/   → 21 个命令模块
 *   - src/cli/modes/      → pipe/subcommand/daemon 模式
 *   - src/cli/themes/     → 主题管理
 *
 * 本文件只负责：从 src/cli/index.ts 导入并运行入口分发逻辑
 */

import {
  mainLoop as startCLI,
  pipeMode,
  subcommandMode,
  printSubcommandHelp,
} from './cli/index';
import { standaloneDaemon } from './cli/modes/daemon';

if (require.main === module) {
  const args = process.argv.slice(2);

  // 0. 优先检查帮助命令
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printSubcommandHelp();
    process.exit(0);
  }

  // 1. daemon 子命令
  if (args[0] === 'daemon') {
    void standaloneDaemon(args.slice(1));
  }
  // 2. 其他子命令模式
  else if (args.length > 0) {
    void subcommandMode(args);
  }
  // 3. 管道模式：有 stdin 输入（不是 TTY）
  else if (!process.stdin.isTTY) {
    void pipeMode(args);
  }
  // 4. 交互式 REPL
  else {
    startCLI().catch((err: Error) => {
      console.error('CLI 启动失败:', err.message);
      process.exit(1);
    });
  }
}

export { startCLI };
