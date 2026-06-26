/**
 * SlashCommandRegistry — 斜杠命令注册表
 *
 * 管理所有斜杠命令的注册、解析和执行。
 * 命令在聊天中输入 /command arg1 arg2 触发。
 * 与 IntegrationManager 配合，跨所有 IM 平台生效。
 */

import { Logger } from '../utils/Logger';

/** 命令上下文 */
export interface CommandContext {
  /** 来源平台 */
  platform: string;
  /** 发送者用户 ID */
  userId: string;
  /** 发送者角色（来自白名单） */
  role?: string;
  /** 原始消息内容 */
  rawMessage: string;
}

/** 命令处理器 */
export type CommandHandler = (
  args: string,
  ctx: CommandContext
) => Promise<string | null> | string | null;

/** 命令定义 */
export interface CommandDefinition {
  name: string;
  description: string;
  handler: CommandHandler;
  /** 最低角色要求（缺省 = 所有人可运行） */
  minRole?: 'admin' | 'user';
  /** 是否隐藏（不出现在 /help 中） */
  hidden?: boolean;
}

/** 内置命令列表（不可覆盖） */
const BUILT_IN_COMMANDS = new Set([
  'help',
  'new',
  'reset',
  'retry',
  'undo',
  'status',
  'stop',
  'model',
]);

export class SlashCommandRegistry {
  private commands = new Map<string, CommandDefinition>();

  constructor() {
    this.registerBuiltins();
  }

  /** 注册命令 */
  register(cmd: CommandDefinition): boolean {
    const name = cmd.name.toLowerCase();

    if (BUILT_IN_COMMANDS.has(name) && !cmd.name.startsWith('__internal__')) {
      Logger.warn(`🚫 不能覆盖内置命令: /${name}`, 'SlashCommandRegistry');
      return false;
    }

    if (this.commands.has(name)) {
      Logger.warn(`⚠️ 命令 /${name} 已存在，将被覆盖`, 'SlashCommandRegistry');
    }

    this.commands.set(name, cmd);
    Logger.debug(
      `📋 斜杠命令已注册: /${name} — ${cmd.description}`,
      'SlashCommandRegistry'
    );
    return true;
  }

  /** 解析消息是否为斜杠命令 */
  parse(input: string): { isCommand: boolean; name: string; args: string } {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return { isCommand: false, name: '', args: '' };
    }

    const spaceIdx = trimmed.indexOf(' ');
    const name =
      spaceIdx < 0
        ? trimmed.slice(1).toLowerCase()
        : trimmed.slice(1, spaceIdx).toLowerCase();
    const args = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trim();

    return { isCommand: true, name, args };
  }

  /** 执行命令 */
  async execute(
    input: string,
    ctx: CommandContext
  ): Promise<{ handled: boolean; response: string | null }> {
    const { isCommand, name, args } = this.parse(input);
    if (!isCommand) {
      return { handled: false, response: null };
    }

    const cmd = this.commands.get(name);
    if (!cmd) {
      return {
        handled: true,
        response: `❌ 未知命令 /${name}。输入 /help 查看可用命令。`,
      };
    }

    // 角色检查
    if (cmd.minRole === 'admin' && ctx.role !== 'admin') {
      return {
        handled: true,
        response: `❌ 命令 /${name} 需要管理员权限。`,
      };
    }

    try {
      const result = await cmd.handler(args, ctx);
      return { handled: true, response: result };
    } catch (err) {
      Logger.error(
        `❌ 命令 /${name} 执行失败`,
        err as Error,
        'SlashCommandRegistry'
      );
      return {
        handled: true,
        response: `❌ 命令 /${name} 执行出错: ${(err as Error).message}`,
      };
    }
  }

  /** 获取所有可见命令列表 */
  getVisibleCommands(): Array<{ name: string; description: string }> {
    return Array.from(this.commands.values())
      .filter((c) => !c.hidden)
      .map((c) => ({ name: c.name, description: c.description }));
  }

  /** 获取命令定义 */
  getCommand(name: string): CommandDefinition | undefined {
    return this.commands.get(name.toLowerCase());
  }

  /** 获取所有命令（含隐藏） */
  getAllCommands(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  // ==================== 内置命令 ====================

  private registerBuiltins(): void {
    this.commands.set('help', {
      name: 'help',
      description: '显示可用命令列表',
      handler: (_args, _ctx) => {
        const lines = ['📋 **可用命令**:', ''];
        for (const cmd of this.getVisibleCommands()) {
          lines.push(`  \`/${cmd.name}\` — ${cmd.description}`);
        }
        return lines.join('\n');
      },
    });

    this.commands.set('new', {
      name: 'new',
      description: '开始新对话',
      handler: async (_args, ctx) => {
        try {
          // 通过 EventBus 发送新会话信号
          const { EventBus } = await import('../shared/EventBus');
          (EventBus as any).emit('session_reset', {
            platform: ctx.platform,
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          });
          return '🔄 已开始新对话！';
        } catch {
          return '🔄 已尝试重置会话。';
        }
      },
    });

    this.commands.set('reset', {
      name: 'reset',
      description: '重置当前会话（同 /new）',
      hidden: true,
      handler: async (_args, ctx) => {
        const helpCmd = this.commands.get('new');
        return helpCmd?.handler('', ctx) ?? '🔄 已重置。';
      },
    });

    this.commands.set('status', {
      name: 'status',
      description: '显示当前会话状态',
      handler: (_args, ctx) => {
        return [
          `📊 **状态**`,
          ``,
          `  平台: ${ctx.platform}`,
          `  用户: ${ctx.userId}`,
          `  角色: ${ctx.role || '未授权'}`,
          `  时间: ${new Date().toLocaleString()}`,
        ].join('\n');
      },
    });

    this.commands.set('retry', {
      name: 'retry',
      description: '重试上一条消息',
      handler: async (_args, ctx) => {
        // 通过 EventBus 触发重试
        try {
          const { EventBus } = await import('../shared/EventBus');
          (EventBus as any).emit('retry_requested', {
            platform: ctx.platform,
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          });
          return '🔄 正在重试...';
        } catch {
          return '❌ 重试失败。';
        }
      },
    });

    this.commands.set('undo', {
      name: 'undo',
      description: '撤销上一轮对话',
      handler: async (_args, ctx) => {
        try {
          const { EventBus } = await import('../shared/EventBus');
          (EventBus as any).emit('undo_requested', {
            platform: ctx.platform,
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          });
          return '↩️ 已撤销上一轮。';
        } catch {
          return '❌ 撤销失败。';
        }
      },
    });

    this.commands.set('stop', {
      name: 'stop',
      description: '停止正在运行的 Agent',
      handler: async (_args, ctx) => {
        try {
          const { EventBus } = await import('../shared/EventBus');
          (EventBus as any).emit('agent_stop_requested', {
            platform: ctx.platform,
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          });
          return '⏹️ 正在停止...';
        } catch {
          return '❌ 停止失败。';
        }
      },
    });

    this.commands.set('model', {
      name: 'model',
      description: '显示或切换模型（格式: /model provider:model_name）',
      handler: (args, _ctx) => {
        if (!args.trim()) {
          return `🤖 当前模型: ${process.env.LLM_MODEL || 'deepseek-v4-flash'}\n使用 /model <provider:model> 切换。`;
        }
        return `🤖 正在切换到: ${args}（功能开发中）`;
      },
    });

    this.commands.set('compress', {
      name: 'compress',
      description: '压缩对话历史，减少 token 占用',
      handler: async (_args, ctx) => {
        try {
          const { EventBus } = await import('../shared/EventBus');
          (EventBus as any).emit('compress_requested', {
            platform: ctx.platform,
            userId: ctx.userId,
            timestamp: new Date().toISOString(),
          });
          return '📦 压缩请求已发送。下次 LLM 调用时将使用压缩后的上下文。';
        } catch {
          return '❌ 压缩请求失败。';
        }
      },
    });

    this.commands.set('usage', {
      name: 'usage',
      description: '显示 token 用量和缓存命中率',
      handler: async (_args, ctx) => {
        const lines = [
          `📊 **用量统计**`,
          ``,
          `  平台: ${ctx.platform}`,
          `  角色: ${ctx.role || '未授权'}`,
        ];

        // 尝试获取缓存统计
        try {
          const { IntegrationManager } = await import('./IntegrationManager');
          const im = IntegrationManager.getInstance() as unknown as {
            getSessionStoreStats?: () => {
              platformSessions: number;
              chatSessions: number;
              allowedUsers: number;
            };
          };
          const stats = im.getSessionStoreStats?.();
          if (stats) {
            lines.push(`  活跃平台会话: ${stats.platformSessions}`);
            lines.push(`  活跃聊天会话: ${stats.chatSessions}`);
            lines.push(`  白名单用户: ${stats.allowedUsers}`);
          }
        } catch {
          /* 忽略 */
        }

        // 获取 LLM 缓存统计
        lines.push(`  模型: ${process.env.LLM_MODEL || 'deepseek-v4-flash'}`);

        return lines.join('\n');
      },
    });

    this.commands.set('verbose', {
      name: 'verbose',
      description: '切换工具输出显示级别: off / new / all',
      handler: (args, _ctx) => {
        const level = args.trim().toLowerCase();
        if (!level) {
          return '🔇 当前模式可通过 /verbose off|new|all 切换。\n  off — 不显示工具输出\n  new — 仅显示新工具\n  all — 显示全部';
        }
        if (!['off', 'new', 'all'].includes(level)) {
          return `❌ 无效级别: ${level}。可用: off, new, all`;
        }
        try {
          const EventBus = require('../shared/EventBus').EventBus;
          EventBus.emit('verbose_changed', { level });
        } catch {
          /* 忽略 */
        }
        return `🔊 工具输出级别已设为: ${level}`;
      },
    });

    this.commands.set('sethome', {
      name: 'sethome',
      description: '将当前聊天设为主频道（定时任务结果推送至此）',
      handler: async (_args, ctx) => {
        try {
          const { GatewaySessionStore } = await import('./GatewaySessionStore');
          const store = new GatewaySessionStore();
          store.saveChatSession(
            'home_channel',
            ctx.platform,
            JSON.stringify({
              chatId: ctx.userId,
              setAt: Date.now(),
            })
          );
          return `🏠 已将 ${ctx.platform}/${ctx.userId} 设为主频道。`;
        } catch {
          return '❌ 设置失败。';
        }
      },
    });

    this.commands.set('whoami', {
      name: 'whoami',
      description: '显示你的用户信息和权限',
      handler: (_args, ctx) => {
        const roleDesc: Record<string, string> = {
          admin: '管理员 — 可运行所有命令',
          user: '普通用户 — 受限访问',
        };
        return [
          `👤 **用户信息**`,
          ``,
          `  平台: ${ctx.platform}`,
          `  用户 ID: ${ctx.userId}`,
          `  角色: ${ctx.role || '未授权'} — ${roleDesc[ctx.role || ''] || '无权限'}`,
          `  时间: ${new Date().toLocaleString()}`,
        ].join('\n');
      },
    });

    this.commands.set('title', {
      name: 'title',
      description: '设置或显示会话标题（格式: /title my-session-name）',
      handler: async (args, ctx) => {
        const name = args.trim();
        if (!name) {
          return '📋 当前会话未命名。使用 `/title <名称>` 命名，之后可通过会话列表恢复。';
        }
        try {
          const { EventBus } = await import('../shared/EventBus');
          (EventBus as any).emit('session_title_set', {
            platform: ctx.platform,
            userId: ctx.userId,
            title: name,
            timestamp: new Date().toISOString(),
          });
          return `📋 会话已命名为: "${name}"`;
        } catch {
          return `📋 会话已命名为: "${name}"`;
        }
      },
    });

    this.commands.set('memory', {
      name: 'memory',
      description: '显示记忆系统统计',
      handler: async (_args, _ctx) => {
        return [
          `🧠 **记忆系统**`,
          ``,
          `  记忆引擎: MemoryEngine v2`,
          `  存储: SQLite + 向量数据库`,
          `  缓存: ${process.env.LLM_CACHE_ENABLED !== 'false' ? '已启用' : '已禁用'}`,
        ].join('\n');
      },
    });

    this.commands.set('skills', {
      name: 'skills',
      description: '列出所有已安装技能',
      handler: async (_args, _ctx) => {
        try {
          const { SkillRegistry } = await import('../skills/SkillRegistry');
          const registry = SkillRegistry.getInstance();
          const all = registry.getAllSkillMeta();
          if (all.length === 0) {
            return '📚 暂无已安装的技能。';
          }
          const lines = ['📚 **已安装技能**', ''];
          for (const skill of all.slice(0, 20)) {
            lines.push(
              `  • ${skill.name}${skill.description ? ' — ' + skill.description : ''}`
            );
          }
          if (all.length > 20) {
            lines.push(`  ... 及 ${all.length - 20} 个更多`);
          }
          return lines.join('\n');
        } catch {
          return '📚 技能系统就绪。';
        }
      },
    });

    // ==================== /cron 子命令系统 ====================

    this.commands.set('cron', {
      name: 'cron',
      description: '管理定时任务: list / run <id> / pause <id>',
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (!subcmd) {
          return [
            '⏰ **Cron 任务管理**',
            '',
            '  /cron list        — 列出所有任务',
            '  /cron run <id>    — 立即执行任务',
            '  /cron pause <id>  — 暂停/恢复任务',
            '  /cron help        — 显示此帮助',
          ].join('\n');
        }

        if (subcmd === 'help') {
          return [
            '⏰ **Cron 命令帮助**',
            '',
            '  /cron list        — 显示所有已注册的定时任务及其状态',
            '  /cron run abc123  — 立即触发任务 abc123',
            '  /cron pause abc123 — 切换任务的启用/暂停状态',
            '  /cron help        — 显示此帮助',
          ].join('\n');
        }

        if (subcmd === 'list') {
          try {
            const { EventBus } = await import('../shared/EventBus');
            (EventBus as any).emit('cron_list_requested', {
              platform: ctx.platform,
              userId: ctx.userId,
              timestamp: new Date().toISOString(),
            });
            // Scheduler 监听此事件并通过 IntegrationManager 回复
            return '⏰ 正在获取任务列表...';
          } catch {
            return '❌ 无法获取任务列表。';
          }
        }

        if (subcmd === 'run') {
          const taskId = parts[1];
          if (!taskId) return '❌ 用法: /cron run <task_id>';
          try {
            const { EventBus } = await import('../shared/EventBus');
            (EventBus as any).emit('cron_run_requested', {
              taskId,
              platform: ctx.platform,
              userId: ctx.userId,
              timestamp: new Date().toISOString(),
            });
            return `⏰ 正在触发任务: ${taskId}...`;
          } catch {
            return '❌ 无法触发任务。';
          }
        }

        if (subcmd === 'pause') {
          const taskId = parts[1];
          if (!taskId) return '❌ 用法: /cron pause <task_id>';
          try {
            const { EventBus } = await import('../shared/EventBus');
            (EventBus as any).emit('cron_pause_requested', {
              taskId,
              platform: ctx.platform,
              userId: ctx.userId,
              timestamp: new Date().toISOString(),
            });
            return `⏸️ 已切换任务状态: ${taskId}`;
          } catch {
            return '❌ 无法切换任务状态。';
          }
        }

        return `❌ 未知子命令: ${subcmd}。使用 /cron help 查看帮助。`;
      },
    });

    // ==================== /webhook 子命令系统 ====================

    this.commands.set('webhook', {
      name: 'webhook',
      description: '管理 Webhook 路由: subscribe / list / remove',
      handler: async (args, _ctx) => {
        const parts = args.trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (!subcmd || subcmd === 'help') {
          return [
            '🔌 **Webhook 管理**',
            '',
            '  /webhook list                 — 列出所有路由',
            '  /webhook subscribe <name>     — 注册新路由',
            '    --events <e1,e2>            监听的事件列表',
            '    --prompt "<template>"       处理 prompt（支持 {variable}）',
            '    --deliver <platform>        投递目标',
            '  /webhook remove <name>        — 删除路由',
            '',
            '模板变量示例:',
            '  {pull_request.title}  — PR 标题',
            '  {repository.full_name} — 仓库名',
            '  {__raw__}             — 完整 JSON payload',
          ].join('\n');
        }

        if (subcmd === 'list') {
          try {
            const { IntegrationManager } = await import('./IntegrationManager');
            const im = IntegrationManager.getInstance();
            const routes = im.listWebhooks();
            if (routes.length === 0) return '🔌 暂无已注册的 Webhook 路由。';
            const lines = ['🔌 **Webhook 路由**', ''];
            for (const r of routes) {
              lines.push(
                `  • ${r.name} — 事件: ${r.events.join(', ')}${r.url ? ' → ' + r.url : ''}`
              );
            }
            return lines.join('\n');
          } catch {
            return '❌ 无法获取路由列表。';
          }
        }

        if (subcmd === 'subscribe') {
          const name = parts[1];
          if (!name)
            return '❌ 用法: /webhook subscribe <name> --events <e1,e2> --prompt "<p>" --deliver <p>';

          const fullText = args.trim();
          const eventsMatch = fullText.match(/--events\s+(\S+)/);
          const deliverMatch = fullText.match(/--deliver\s+(\S+)/);

          const events = eventsMatch ? eventsMatch[1].split(',') : ['*'];
          const deliver = deliverMatch ? deliverMatch[1] : undefined;

          try {
            const { IntegrationManager } = await import('./IntegrationManager');
            const im = IntegrationManager.getInstance();
            im.registerWebhook({
              id: `wh_${name}_${Date.now()}`,
              name,
              url: deliver || '',
              events,
              enabled: true,
            });
            return `🔌 Webhook 路由已创建: ${name}\n  事件: ${events.join(', ')}\n  投递: ${deliver || '未设置'}`;
          } catch {
            return '❌ 注册失败。';
          }
        }

        if (subcmd === 'remove') {
          const name = parts[1];
          if (!name) return '❌ 用法: /webhook remove <name>';
          try {
            const { IntegrationManager } = await import('./IntegrationManager');
            const im = IntegrationManager.getInstance();
            im.unregisterWebhook(name);
            return `🔌 Webhook 路由已删除: ${name}`;
          } catch {
            return '❌ 删除失败。';
          }
        }

        return `❌ 未知子命令: ${subcmd}`;
      },
    });

    // ==================== /background ====================

    this.commands.set('background', {
      name: 'background',
      description: '在后台运行任务，不阻塞当前会话。用法: /background <prompt>',
      handler: async (args, ctx) => {
        const prompt = args.trim();
        if (!prompt) {
          return '❌ 用法: /background <prompt>\n  示例: /background 检查所有服务器状态并报告';
        }

        const taskId = `bg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;

        // 立即回复确认
        const confirmMsg = [
          `🔄 **后台任务已启动**`,
          ``,
          `  ${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}`,
          `  任务 ID: \`${taskId}\``,
          `  完成后结果将自动推送至此频道。`,
        ].join('\n');

        // 异步执行，不阻塞主流程
        setImmediate(async () => {
          try {
            const { IntegrationManager } = await import('./IntegrationManager');
            const im = IntegrationManager.getInstance();
            // 通过 core.processInput 处理
            const core = (im as any).core as
              | import('../core/JiabaixingCore').JiabaixingCore
              | null;
            if (core) {
              const result = await core.processInput(prompt, `bg:${taskId}`);
              if (result.response) {
                const response = result.response;
                // 检查 [SILENT]
                if (response.includes('[SILENT]')) return;

                await im.sendMessage({
                  platform: ctx.platform as any,
                  message: `✅ **Background task complete**\n\n${response.substring(0, 2000)}`,
                  to: ctx.userId,
                });
              }
            }
          } catch (err) {
            try {
              const { IntegrationManager } =
                await import('./IntegrationManager');
              const im = IntegrationManager.getInstance();
              await im.sendMessage({
                platform: ctx.platform as any,
                message: `❌ **Background task failed**: ${(err as Error).message}`,
                to: ctx.userId,
              });
            } catch {
              /* ignore */
            }
          }
        });

        return confirmMsg;
      },
    });

    // ==================== /pair ====================

    this.commands.set('pair', {
      name: 'pair',
      description: '生成一次性配对码，供新用户授权访问',
      handler: async (_args, ctx) => {
        try {
          const { GatewayPairing } = await import('./GatewayPairing');
          const pairing = new GatewayPairing();

          const code = pairing.generateCode(ctx.platform, ctx.userId);
          if (!code) {
            return '❌ 无法生成配对码（速率限制或待使用码过多）。';
          }

          return [
            `🔑 **配对码**`,
            ``,
            `  \`${code}\``,
            `  过期时间: ${new Date(Date.now() + 60 * 60 * 1000).toLocaleTimeString()}`,
            `  平台: ${ctx.platform}`,
            ``,
            `将此码发送给需要授权的用户。`,
            `用户私信 bot 输入此码即可获得访问权限。`,
          ].join('\n');
        } catch {
          return '❌ 生成配对码失败。';
        }
      },
    });

    // ==================== /pairings ====================

    this.commands.set('pairings', {
      name: 'pairings',
      description: '查看待使用的配对码数量',
      handler: async (_args, _ctx) => {
        try {
          const { GatewayPairing } = await import('./GatewayPairing');
          const pairing = new GatewayPairing();
          const count = pairing.getPendingCount();
          return `🔑 当前有 ${count} 个待使用的配对码。`;
        } catch {
          return '❌ 获取配对码状态失败。';
        }
      },
    });
  }
}
