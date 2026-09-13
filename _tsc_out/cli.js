"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCLI = void 0;
const index_1 = require("./cli/index");
Object.defineProperty(exports, "startCLI", { enumerable: true, get: function () { return index_1.mainLoop; } });
const daemon_1 = require("./cli/modes/daemon");
const runtimePosture_1 = require("./cli/runtimePosture");
if (require.main === module) {
    // 全局安全姿态标志（--safe-mode/--yolo/--auto/--posture）先行解析并写入 env，
    // 再从后续参数中剔除，避免干扰子命令/管道解析。真正裁决在 Python 后端。
    const args = (0, runtimePosture_1.applyRuntimePostureFlags)(process.argv.slice(2));
    // 0. 优先检查帮助命令
    if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
        (0, index_1.printSubcommandHelp)();
        process.exit(0);
    }
    // 1. daemon 子命令（即使在管道中也要优先处理）
    if (args[0] === 'daemon') {
        void (0, daemon_1.standaloneDaemon)(args.slice(1));
    }
    // 2. 管道模式：有 stdin 输入（不是 TTY）— 优先级高于子命令
    //    因为 --json/--quiet 是管道模式的选项，不是子命令
    else if (!process.stdin.isTTY) {
        void (0, index_1.pipeMode)(args);
    }
    // 3. 子命令模式（仅在 TTY 且有参数时）
    else if (args.length > 0) {
        void (0, index_1.subcommandMode)(args);
    }
    // 4. 交互式 REPL
    else {
        (0, index_1.mainLoop)().catch((err) => {
            console.error('CLI 启动失败:', err.message);
            process.exit(1);
        });
    }
}
