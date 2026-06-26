import { Logger } from '../../utils/Logger';
import { handleAskCommand } from '../commands/chat';
import { handleContextCommandCLI } from '../commands/context';
import { handleConversationsCommandCLI } from '../commands/conversations';
import { handleCuratorCommandCLI } from '../commands/curator';
import { handleDocsCommandCLI } from '../commands/docs';
import { handleEvolutionCommandCLI } from '../commands/evolution';
import { handleGatewayCommandCLI } from '../commands/gateway';
import { handleHermesCommandCLI } from '../commands/hermes';
import { handleMcpCommandCLI } from '../commands/mcp';
import { handleMemoryCommandCLI } from '../commands/memory';
import { handleModelCommandCLI } from '../commands/model';
import { handlePerformanceCommandCLI } from '../commands/performance';
import { handleScheduleCommand } from '../commands/schedule';
import { handleSearchCommand } from '../commands/search';
import { handleSecurityCommandCLI } from '../commands/security';
import { handleSkillCommand } from '../commands/skills';
import { handleStatusCommandCLI } from '../commands/status';
import { handleSystemCommandCLI } from '../commands/system';
import { parseGlobalOptions } from '../utils';

/**
 * 打印子命令帮助信息
 */
export function printSubcommandHelp(): void {
  process.stdout.write(`Jiabaixing CLI 子命令

用法:
  npx tsx src/cli.ts <子命令> [参数] [选项]

子命令:
  ask <问题>              单次问答，输出结果后退出
  skill list              列出技能
  skill execute <名称> [参数]  执行技能
  schedule list           列出定时任务
  schedule add <名称> <cron> <描述>  添加定时任务
  status                  查看系统状态
  memory stats            查看记忆统计
  memory search <关键词>   搜索记忆
  memory store <内容>      存储记忆
  memory profile          查看用户画像
  evolution status        查看进化状态
  gateway list            列出网关状态
  gateway connect <平台>  连接平台
  context list            列出已加载的上下文文件
  context refresh         刷新上下文文件缓存
  context create [文件名] 创建上下文文件模板（默认 JIABAIXING.md）
  context read <文件名>   读取指定上下文文件内容
  search <查询>           网页搜索
  docs list               列出可用文档
  docs generate [scope]   生成文档（scope: all/api/cli, 默认 all）
  docs view <名称>        查看指定文档
  curator status          查看 Curator 状态
  curator run [--dry-run] [--background]  执行技能库维护
  curator backup [原因]   手动创建备份
  curator rollback [--list] [--id <ts>] [-y]  回滚备份
  curator pause           暂停自动运行
  curator resume          恢复自动运行
  curator pin <技能>      固定技能
  curator unpin <技能>    取消固定
  curator restore <技能>  恢复已归档技能
  hermes batch <p1> [p2...]  批量并行运行多个 prompt
  hermes ide <message>       IDE 聊天（ACP 协议）
  hermes trajectory stats    查看 RL 轨迹统计
  hermes trajectory export [format]  导出轨迹（sharegpt/jsonl/openai_finetune）
  hermes tool <name> [k=v...] 执行任意已注册工具
  hermes image <prompt>      生成图像
  hermes tts <text>          文本转语音
  hermes fetch <url>         抓取网页内容

全局选项:
  --json                  以 JSON 格式输出
  --quiet, -q             只输出结果，不输出额外信息

管道模式:
  echo "你好" | npx tsx src/cli.ts
  cat question.txt | npx tsx src/cli.ts --json

示例:
  npx tsx src/cli.ts ask "今天天气怎么样"
  npx tsx src/cli.ts skill list --json
  npx tsx src/cli.ts status
  npx tsx src/cli.ts context list
  npx tsx src/cli.ts context create JIABAIXING.md
  npx tsx src/cli.ts context read JIABAIXING.md
  echo "帮我写一段代码" | npx tsx src/cli.ts
`);
}

/**
 * 子命令模式：解析子命令参数，调用对应后端 API，输出结果后退出
 * @param args - 命令行参数（不含 node 和脚本路径）
 */
export async function subcommandMode(args: string[]): Promise<void> {
  const { positional, options } = parseGlobalOptions(args);
  const command = positional[0];

  if (!command) {
    process.stderr.write('错误: 缺少子命令\n');
    printSubcommandHelp();
    process.exit(1);
  }

  try {
    switch (command) {
      case 'ask':
        await handleAskCommand(positional.slice(1).join(' '), options);
        break;
      case 'skill':
        await handleSkillCommand(positional.slice(1), options);
        break;
      case 'schedule':
        await handleScheduleCommand(positional.slice(1), options);
        break;
      case 'status':
        await handleStatusCommandCLI(options);
        break;
      case 'memory':
        await handleMemoryCommandCLI(positional.slice(1), options);
        break;
      case 'evolution':
        await handleEvolutionCommandCLI(positional.slice(1), options);
        break;
      case 'gateway':
        await handleGatewayCommandCLI(positional.slice(1), options);
        break;
      case 'context':
        await handleContextCommandCLI(positional.slice(1), options);
        break;
      case 'model':
        await handleModelCommandCLI(positional.slice(1), options);
        break;
      case 'security':
        await handleSecurityCommandCLI(positional.slice(1), options);
        break;
      case 'performance':
        await handlePerformanceCommandCLI(positional.slice(1), options);
        break;
      case 'mcp':
        await handleMcpCommandCLI(positional.slice(1), options);
        break;
      case 'system':
        await handleSystemCommandCLI(positional.slice(1), options);
        break;
      case 'conversations':
        await handleConversationsCommandCLI(positional.slice(1), options);
        break;
      case 'docs':
        await handleDocsCommandCLI(positional.slice(1), options);
        break;
      case 'search':
        await handleSearchCommand(positional.slice(1).join(' '), options);
        break;
      case 'curator':
        await handleCuratorCommandCLI(positional.slice(1), options);
        break;
      case 'hermes':
        await handleHermesCommandCLI(positional.slice(1), options);
        break;
      case 'help':
      case '--help':
      case '-h':
        printSubcommandHelp();
        break;
      default:
        process.stderr.write(`未知子命令: ${command}\n`);
        printSubcommandHelp();
        process.exit(1);
    }
  } catch (err) {
    Logger.error(`子命令 ${command} 执行失败`, err as Error, 'SubcommandMode');
    process.stderr.write(`错误: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
