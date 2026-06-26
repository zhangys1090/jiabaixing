import { Logger } from '../../utils/Logger';
import { COLORS } from '../constants';
import { requestWithFallback } from '../ipc';
import { SubcommandOptions } from '../types';

interface BatchPrompt {
  id: string;
  text: string;
}

interface BatchResultItem {
  id: string;
  success: boolean;
  response?: string;
  error?: string;
  duration?: number;
}

interface TrajectoryStats {
  total: number;
  filtered: number;
  avgQuality: number;
  avgSteps: number;
}

interface ToolExecuteResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata?: { duration?: number };
}

function parseKVArgs(args: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const arg of args) {
    const idx = arg.indexOf('=');
    if (idx > 0) {
      params[arg.slice(0, idx)] = arg.slice(idx + 1);
    }
  }
  return params;
}

export async function handleHermesCommandCLI(
  subArgs: string[],
  options: SubcommandOptions
): Promise<void> {
  const action = subArgs[0] || 'help';

  switch (action) {
    case 'batch': {
      const prompts = subArgs.slice(1).filter(Boolean);
      if (prompts.length === 0) {
        process.stderr.write('错误: hermes batch 需要至少一个 prompt\n');
        process.stderr.write('用法: hermes batch "你好" "介绍一下自己"\n');
        process.exit(1);
      }

      const batchPrompts: BatchPrompt[] = prompts.map((text, i) => ({
        id: `p${i + 1}`,
        text,
      }));

      try {
        const data = await requestWithFallback<{
          format: string;
          data: BatchResultItem[] | string;
        }>(
          'hermes.batch',
          { prompts: batchPrompts },
          { path: '/api/batch/run' }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const items = Array.isArray(data.data) ? data.data : [];
          const successCount = items.filter((r) => r.success).length;
          process.stdout.write(
            `\n批处理完成（${successCount}/${items.length} 成功）\n\n`
          );
          for (const r of items) {
            const mark = r.success ? '✅' : '❌';
            const text = r.success
              ? (r.response || '').substring(0, 120)
              : r.error || '失败';
            const dur = r.duration ? ` (${r.duration}ms)` : '';
            process.stdout.write(`  ${mark} [${r.id}] ${text}${dur}\n`);
          }
        }
      } catch (err) {
        Logger.error('批处理失败', err as Error, 'HermesCommand');
        process.stderr.write(`批处理失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'ide': {
      const message = subArgs.slice(1).join(' ').trim();
      if (!message) {
        process.stderr.write('错误: hermes ide 需要消息内容\n');
        process.stderr.write('用法: hermes ide "帮我写一个函数"\n');
        process.exit(1);
      }

      try {
        const data = await requestWithFallback<{
          content: string;
          sessionId: string;
        }>('hermes.ide.chat', { message }, { path: '/api/ide/chat' });

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(`\n会话: ${data.sessionId}\n`);
          process.stdout.write(`响应: ${data.content}\n`);
        }
      } catch (err) {
        Logger.error('IDE 聊天失败', err as Error, 'HermesCommand');
        process.stderr.write(`IDE 聊天失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'trajectory': {
      const subAction = subArgs[1] || 'stats';

      if (subAction === 'stats') {
        try {
          const data = await requestWithFallback<TrajectoryStats>(
            'hermes.trajectory.stats',
            {},
            { path: '/api/trajectory/stats' }
          );

          if (options.json) {
            process.stdout.write(JSON.stringify(data, null, 2) + '\n');
          } else {
            process.stdout.write(
              `\n  ${COLORS.bold}RL 轨迹统计${COLORS.reset}\n\n`
            );
            process.stdout.write(`  总轨迹:   ${data.total}\n`);
            process.stdout.write(`  已过滤:   ${data.filtered}\n`);
            process.stdout.write(
              `  平均质量: ${(data.avgQuality * 100).toFixed(1)}%\n`
            );
            process.stdout.write(`  平均步数: ${data.avgSteps}\n\n`);
          }
        } catch (err) {
          Logger.error('轨迹统计失败', err as Error, 'HermesCommand');
          process.stderr.write(`轨迹统计失败: ${(err as Error).message}\n`);
          process.exit(1);
        }
      } else if (subAction === 'export') {
        const format =
          (subArgs[2] as 'sharegpt' | 'jsonl' | 'openai_finetune') || 'jsonl';
        try {
          const data = await requestWithFallback<unknown>(
            'hermes.trajectory.export',
            { format },
            { path: '/api/trajectory/export' }
          );

          if (options.json) {
            process.stdout.write(JSON.stringify(data, null, 2) + '\n');
          } else {
            const output =
              typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            process.stdout.write(output.substring(0, 5000));
            if (output.length > 5000) {
              process.stdout.write(`\n... (截断，共 ${output.length} 字符)\n`);
            }
          }
        } catch (err) {
          Logger.error('轨迹导出失败', err as Error, 'HermesCommand');
          process.stderr.write(`轨迹导出失败: ${(err as Error).message}\n`);
          process.exit(1);
        }
      } else {
        process.stderr.write(`未知子命令: hermes trajectory ${subAction}\n`);
        process.stderr.write('可用: stats, export\n');
        process.exit(1);
      }
      break;
    }

    case 'tool': {
      const toolName = subArgs[1];
      if (!toolName) {
        process.stderr.write('错误: hermes tool 需要工具名称\n');
        process.stderr.write(
          '用法: hermes tool image_generate prompt="a cat"\n'
        );
        process.exit(1);
      }

      const params = parseKVArgs(subArgs.slice(2));

      try {
        const data = await requestWithFallback<ToolExecuteResponse>(
          'hermes.tool.execute',
          { toolName, params },
          { path: '/api/tools/execute' }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          if (!data.success) {
            process.stdout.write(`❌ ${data.error || '执行失败'}\n`);
          } else {
            const output =
              typeof data.output === 'string'
                ? data.output
                : JSON.stringify(data.output, null, 2);
            const dur = data.metadata?.duration
              ? ` (${data.metadata.duration}ms)`
              : '';
            process.stdout.write(`✅ ${output}${dur}\n`);
          }
        }
      } catch (err) {
        Logger.error('工具执行失败', err as Error, 'HermesCommand');
        process.stderr.write(`工具执行失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'image': {
      const prompt = subArgs.slice(1).join(' ').trim();
      if (!prompt) {
        process.stderr.write('错误: hermes image 需要图像描述\n');
        process.stderr.write('用法: hermes image "a cute cat"\n');
        process.exit(1);
      }

      try {
        const data = await requestWithFallback<ToolExecuteResponse>(
          'hermes.tool.image',
          { toolName: 'image_generate', params: { prompt } },
          { path: '/api/tools/execute' }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(
            data.success
              ? `✅ ${JSON.stringify(data.output)}\n`
              : `❌ ${data.error}\n`
          );
        }
      } catch (err) {
        Logger.error('图像生成失败', err as Error, 'HermesCommand');
        process.stderr.write(`图像生成失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'tts': {
      const text = subArgs.slice(1).join(' ').trim();
      if (!text) {
        process.stderr.write('错误: hermes tts 需要文本内容\n');
        process.stderr.write('用法: hermes tts "你好世界"\n');
        process.exit(1);
      }

      try {
        const data = await requestWithFallback<ToolExecuteResponse>(
          'hermes.tool.tts',
          { toolName: 'tts_speak', params: { text } },
          { path: '/api/tools/execute' }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          process.stdout.write(
            data.success
              ? `✅ ${JSON.stringify(data.output)}\n`
              : `❌ ${data.error}\n`
          );
        }
      } catch (err) {
        Logger.error('TTS 失败', err as Error, 'HermesCommand');
        process.stderr.write(`TTS 失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'fetch': {
      const url = subArgs[1];
      if (!url) {
        process.stderr.write('错误: hermes fetch 需要 URL\n');
        process.stderr.write('用法: hermes fetch https://example.com\n');
        process.exit(1);
      }

      try {
        const data = await requestWithFallback<ToolExecuteResponse>(
          'hermes.tool.fetch',
          { toolName: 'web_fetch', params: { url } },
          { path: '/api/tools/execute' }
        );

        if (options.json) {
          process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        } else {
          const output = data.success
            ? typeof data.output === 'string'
              ? data.output
              : JSON.stringify(data.output)
            : data.error || '失败';
          process.stdout.write(
            data.success ? `✅ ${output.substring(0, 500)}\n` : `❌ ${output}\n`
          );
        }
      } catch (err) {
        Logger.error('网页抓取失败', err as Error, 'HermesCommand');
        process.stderr.write(`网页抓取失败: ${(err as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default: {
      process.stdout.write(`Hermes 特性增强命令

用法:
  npx tsx src/cli.ts hermes <子命令> [参数]

子命令:
  batch <prompt1> [prompt2...]    批量并行运行多个 prompt
  ide <message>                   IDE 聊天（ACP 协议）
  trajectory stats                查看 RL 轨迹统计
  trajectory export [format]      导出轨迹（sharegpt/jsonl/openai_finetune）
  tool <name> [key=val...]        执行任意已注册工具
  image <prompt>                  生成图像
  tts <text>                      文本转语音
  fetch <url>                     抓取网页内容

示例:
  npx tsx src/cli.ts hermes batch "你好" "介绍一下自己"
  npx tsx src/cli.ts hermes ide "帮我写一个排序函数"
  npx tsx src/cli.ts hermes trajectory stats
  npx tsx src/cli.ts hermes trajectory export jsonl
  npx tsx src/cli.ts hermes tool image_generate prompt="a cat" size=square
  npx tsx src/cli.ts hermes image "a cute cat"
  npx tsx src/cli.ts hermes tts "你好世界"
  npx tsx src/cli.ts hermes fetch https://example.com
`);
      break;
    }
  }
}
