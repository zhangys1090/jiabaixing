/**
 * SlashCommandRegistry 单元测试
 */
import {
  SlashCommandRegistry,
  CommandContext,
} from '../../../src/integration/SlashCommandRegistry';

jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('SlashCommandRegistry', () => {
  let registry: SlashCommandRegistry;
  const testCtx: CommandContext = {
    platform: 'test',
    userId: 'u1',
    role: 'admin',
    rawMessage: '',
  };

  beforeEach(() => {
    registry = new SlashCommandRegistry();
  });

  describe('解析', () => {
    it('应识别 / 开头的命令', () => {
      const result = registry.parse('/help');
      expect(result.isCommand).toBe(true);
      expect(result.name).toBe('help');
      expect(result.args).toBe('');
    });

    it('应提取命令名称和参数', () => {
      const result = registry.parse('/model deepseek:deepseek-v4');
      expect(result.isCommand).toBe(true);
      expect(result.name).toBe('model');
      expect(result.args).toBe('deepseek:deepseek-v4');
    });

    it('非命令消息应返回 false', () => {
      const result = registry.parse('你好');
      expect(result.isCommand).toBe(false);
    });

    it('命令名应转为小写', () => {
      const result = registry.parse('/HELP me');
      expect(result.name).toBe('help');
      expect(result.args).toBe('me');
    });
  });

  describe('内置命令', () => {
    it('/help 应返回可用命令列表', async () => {
      const r = await registry.execute('/help', testCtx);
      expect(r.handled).toBe(true);
      expect(r.response).toContain('/status');
    });

    it('/status 应返回会话状态', async () => {
      const r = await registry.execute('/status', testCtx);
      expect(r.handled).toBe(true);
      expect(r.response).toContain('test');
    });

    it('/new 应返回确认', async () => {
      const r = await registry.execute('/new', testCtx);
      expect(r.handled).toBe(true);
    });

    it('未知命令应返回错误提示', async () => {
      const r = await registry.execute('/nonexistent', testCtx);
      expect(r.handled).toBe(true);
      expect(r.response).toContain('未知命令');
    });
  });

  describe('注册自定义命令', () => {
    it('应注册和执行自定义命令', async () => {
      registry.register({
        name: 'ping',
        description: '返回 pong',
        handler: () => 'pong',
      });

      const r = await registry.execute('/ping', testCtx);
      expect(r.handled).toBe(true);
      expect(r.response).toBe('pong');
    });

    it('自定义命令应出现在 /help 中', async () => {
      registry.register({
        name: 'echo',
        description: 'echo 测试',
        handler: (args) => args,
      });

      const r = await registry.execute('/help', testCtx);
      expect(r.response).toContain('/echo');
    });

    it('自定义命令可获取参数', async () => {
      registry.register({
        name: 'echo',
        description: 'echo 测试',
        handler: (args) => `你输入了: ${args}`,
      });

      const r = await registry.execute('/echo 你好世界', testCtx);
      expect(r.response).toBe('你输入了: 你好世界');
    });
  });

  describe('角色权限', () => {
    it('admin 要求的命令应拒绝普通用户', async () => {
      registry.register({
        name: 'admin-only',
        description: '仅管理员',
        minRole: 'admin',
        handler: () => 'secret',
      });

      const userCtx: CommandContext = {
        platform: 'test',
        userId: 'u2',
        role: 'user',
        rawMessage: '',
      };
      const r = await registry.execute('/admin-only', userCtx);
      expect(r.response).toContain('管理员权限');
    });

    it('admin 要求的命令应允许管理员', async () => {
      registry.register({
        name: 'admin-only',
        description: '仅管理员',
        minRole: 'admin',
        handler: () => 'secret',
      });

      const r = await registry.execute('/admin-only', testCtx);
      expect(r.response).toBe('secret');
    });
  });

  describe('内置命令保护', () => {
    it('不能覆盖内置命令', () => {
      const result = registry.register({
        name: 'help',
        description: '自定义 help',
        handler: () => 'custom',
      });
      expect(result).toBe(false);
    });
  });

  describe('隐藏命令', () => {
    it('隐藏命令不在 /help 中显示', () => {
      // reset 是隐藏的
      const visible = registry.getVisibleCommands();
      expect(visible.find((c) => c.name === 'reset')).toBeUndefined();
    });
  });

  describe('新增内置命令', () => {
    it('/verbose 应返回模式说明', async () => {
      const r = await registry.execute('/verbose', testCtx);
      expect(r.handled).toBe(true);
      expect(r.response).toContain('/verbose');
    });

    it('/verbose all 应设置级别', async () => {
      const r = await registry.execute('/verbose all', testCtx);
      expect(r.response).toContain('all');
    });

    it('/whoami 应返回用户信息', async () => {
      const r = await registry.execute('/whoami', testCtx);
      expect(r.response).toContain('admin');
      expect(r.response).toContain('test');
    });

    it('/sethome 应返回确认', async () => {
      const r = await registry.execute('/sethome', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/usage 应返回统计', async () => {
      const r = await registry.execute('/usage', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/compress 应返回确认', async () => {
      const r = await registry.execute('/compress', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/cron 应显示帮助', async () => {
      const r = await registry.execute('/cron', testCtx);
      expect(r.response).toContain('list');
    });

    it('/cron help 应显示帮助', async () => {
      const r = await registry.execute('/cron help', testCtx);
      expect(r.response).toContain('run');
    });

    it('/cron list 应返回确认', async () => {
      const r = await registry.execute('/cron list', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/cron run 无参数应返回错误', async () => {
      const r = await registry.execute('/cron run', testCtx);
      expect(r.response).toContain('用法');
    });

    it('/cron run <id> 应返回确认', async () => {
      const r = await registry.execute('/cron run task-123', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/cron pause <id> 应返回确认', async () => {
      const r = await registry.execute('/cron pause task-123', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/title 无参数应返回提示', async () => {
      const r = await registry.execute('/title', testCtx);
      expect(r.response).toContain('命名');
    });

    it('/title 应返回确认', async () => {
      const r = await registry.execute('/title my-project', testCtx);
      expect(r.response).toContain('my-project');
    });

    it('/background 无参数应返回错误', async () => {
      const r = await registry.execute('/background', testCtx);
      expect(r.response).toContain('用法');
    });

    it('/background 应返回确认', async () => {
      const r = await registry.execute('/background 检查服务器状态', testCtx);
      expect(r.response).toContain('后台任务');
    });

    it('/webhook 应显示帮助', async () => {
      const r = await registry.execute('/webhook', testCtx);
      expect(r.response).toContain('subscribe');
    });

    it('/webhook list 应返回确认', async () => {
      const r = await registry.execute('/webhook list', testCtx);
      expect(r.handled).toBe(true);
    });

    it('/webhook subscribe 无参数应返回错误', async () => {
      const r = await registry.execute('/webhook subscribe', testCtx);
      expect(r.response).toContain('用法');
    });
  });

  describe('异步处理器', () => {
    it('应支持异步 handler', async () => {
      registry.register({
        name: 'async-cmd',
        description: '异步测试',
        handler: async (args) => {
          return `async: ${args}`;
        },
      });

      const r = await registry.execute('/async-cmd hello', testCtx);
      expect(r.response).toBe('async: hello');
    });
  });

  describe('错误处理', () => {
    it('处理器抛异常应返回错误', async () => {
      registry.register({
        name: 'crash',
        description: '会崩溃',
        handler: () => {
          throw new Error('boom');
        },
      });

      const r = await registry.execute('/crash', testCtx);
      expect(r.response).toContain('boom');
    });
  });
});
