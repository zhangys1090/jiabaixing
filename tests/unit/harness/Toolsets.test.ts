/**
 * 工具集系统（Toolsets）单元测试
 *
 * 测试 ToolsetRegistry 的注册、继承解析、分类展开、排除、截断
 * 以及 builtinToolsets 的内置定义
 */

import { ToolRegistry } from '../../../src/harness/tools/registry/ToolRegistry';
import { getToolsetRegistry } from '../../../src/harness/tools/toolsets';
import {
  resetToolsetRegistry,
  ToolsetRegistry,
} from '../../../src/harness/tools/toolsets/ToolsetRegistry';
import {
  AGENT_TOOLSET_MAP,
  BUILTIN_TOOLSETS,
  getDefaultToolsetForAgent,
  registerBuiltinToolsets,
} from '../../../src/harness/tools/toolsets/builtinToolsets';
import { ToolCategory, type ToolDefinition } from '../../../src/harness/types';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock PerformanceMonitor
jest.mock('../../../src/monitoring/PerformanceMonitor', () => ({
  perf: {
    measure: jest.fn(<T>(_name: string, fn: () => T) => fn()),
  },
}));

function makeToolDef(name: string, category: ToolCategory): ToolDefinition {
  return {
    name,
    description: `${name} 工具`,
    category,
    parameters: {},
    requiredParams: [],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
  };
}

function makeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const tools: Array<[string, ToolCategory]> = [
    ['memory_recall', ToolCategory.MEMORY],
    ['memory_search', ToolCategory.MEMORY],
    ['memory_store', ToolCategory.MEMORY],
    ['self_reflect', ToolCategory.COGNITION],
    ['emotion_detect', ToolCategory.COGNITION],
    ['scene_analyze', ToolCategory.COGNITION],
    ['file_read', ToolCategory.FILE],
    ['file_list', ToolCategory.FILE],
    ['file_grep', ToolCategory.FILE],
    ['code_generate', ToolCategory.CODE],
    ['code_analyze', ToolCategory.CODE],
    ['desktop_automate', ToolCategory.DESKTOP],
    ['desktop_screenshot', ToolCategory.DESKTOP],
    ['task_manage', ToolCategory.DAILY],
    ['reminder_set', ToolCategory.DAILY],
    ['web_search', ToolCategory.NETWORK],
    ['web_fetch', ToolCategory.NETWORK],
    ['shell_exec', ToolCategory.SYSTEM],
    ['execute_code', ToolCategory.SYSTEM],
    ['ask_clarification', ToolCategory.SYSTEM],
    ['system_status', ToolCategory.SYSTEM],
  ];
  for (const [name, cat] of tools) {
    registry.register(makeToolDef(name, cat), async () => ({
      success: true,
      output: 'ok',
      duration: 0,
      validated: false,
    }));
  }
  return registry;
}

describe('工具集系统（Toolsets）', () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    resetToolsetRegistry();
    toolRegistry = makeToolRegistry();
  });

  describe('ToolsetRegistry', () => {
    let registry: ToolsetRegistry;

    beforeEach(() => {
      registry = new ToolsetRegistry();
    });

    it('应该注册和获取工具集定义', () => {
      registry.register({
        id: 'test',
        displayName: '测试集',
        description: '测试',
        includes: [{ name: 'file_read' }],
      });
      const def = registry.get('test');
      expect(def).toBeDefined();
      expect(def?.id).toBe('test');
      expect(def?.displayName).toBe('测试集');
    });

    it('应该列出所有工具集 id', () => {
      registry.register({
        id: 'a',
        displayName: 'A',
        description: '',
        includes: [],
      });
      registry.register({
        id: 'b',
        displayName: 'B',
        description: '',
        includes: [],
      });
      expect(registry.list().sort()).toEqual(['a', 'b']);
    });

    it('应该解析精确工具名', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ name: 'file_read' }, { name: 'file_list' }],
      });
      const resolved = registry.resolve('test', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames).toContain('file_read');
      expect(resolved?.toolNames).toContain('file_list');
      expect(resolved?.toolNames).toHaveLength(2);
    });

    it('应该解析整个分类', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ category: ToolCategory.MEMORY }],
      });
      const resolved = registry.resolve('test', toolRegistry);
      expect(resolved?.toolNames).toContain('memory_recall');
      expect(resolved?.toolNames).toContain('memory_search');
      expect(resolved?.toolNames).toContain('memory_store');
    });

    it('应该跳过不存在的工具名', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ name: 'file_read' }, { name: 'nonexistent_tool' }],
      });
      const resolved = registry.resolve('test', toolRegistry);
      expect(resolved?.toolNames).toEqual(['file_read']);
    });

    it('应该应用 excludes 排除工具', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ category: ToolCategory.MEMORY }],
        excludes: ['memory_search'],
      });
      const resolved = registry.resolve('test', toolRegistry);
      expect(resolved?.toolNames).toContain('memory_recall');
      expect(resolved?.toolNames).toContain('memory_store');
      expect(resolved?.toolNames).not.toContain('memory_search');
    });

    it('应该支持继承（extends）', () => {
      registry.register({
        id: 'parent',
        displayName: '父集',
        description: '',
        includes: [{ name: 'file_read' }],
      });
      registry.register({
        id: 'child',
        displayName: '子集',
        description: '',
        extends: 'parent',
        includes: [{ name: 'file_list' }],
      });
      const resolved = registry.resolve('child', toolRegistry);
      expect(resolved?.toolNames).toContain('file_read');
      expect(resolved?.toolNames).toContain('file_list');
      expect(resolved?.resolvedFrom).toContain('parent');
      expect(resolved?.resolvedFrom).toContain('child');
    });

    it('应该支持多级继承', () => {
      registry.register({
        id: 'grandparent',
        displayName: '祖父',
        description: '',
        includes: [{ name: 'file_read' }],
      });
      registry.register({
        id: 'parent',
        displayName: '父',
        description: '',
        extends: 'grandparent',
        includes: [{ name: 'file_list' }],
      });
      registry.register({
        id: 'child',
        displayName: '子',
        description: '',
        extends: 'parent',
        includes: [{ name: 'file_grep' }],
      });
      const resolved = registry.resolve('child', toolRegistry);
      expect(resolved?.toolNames).toContain('file_read');
      expect(resolved?.toolNames).toContain('file_list');
      expect(resolved?.toolNames).toContain('file_grep');
    });

    it('应该应用 maxTools 截断', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [
          { name: 'file_read' },
          { name: 'file_list' },
          { name: 'file_grep' },
        ],
        maxTools: 2,
      });
      const resolved = registry.resolve('test', toolRegistry);
      expect(resolved?.toolNames).toHaveLength(2);
    });

    it('应该缓存解析结果', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ name: 'file_read' }],
      });
      const r1 = registry.resolve('test', toolRegistry);
      const r2 = registry.resolve('test', toolRegistry);
      expect(r1).toBe(r2); // 同一引用（缓存命中）
    });

    it('invalidateCache 应清除缓存', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ name: 'file_read' }],
      });
      registry.resolve('test', toolRegistry);
      registry.invalidateCache('test');
      const r2 = registry.resolve('test', toolRegistry);
      expect(r2).toBeDefined();
    });

    it('对不存在的 id 应返回 undefined', () => {
      expect(registry.resolve('nonexistent', toolRegistry)).toBeUndefined();
    });

    it('resolveToOpenAI 应返回 OpenAI Function Calling 格式', () => {
      registry.register({
        id: 'test',
        displayName: '测试',
        description: '',
        includes: [{ name: 'file_read' }, { name: 'file_list' }],
      });
      const tools = registry.resolveToOpenAI('test', toolRegistry);
      expect(tools.length).toBe(2);
      const names = tools.map((t) => (t.function as { name: string }).name);
      expect(names).toContain('file_read');
      expect(names).toContain('file_list');
    });
  });

  describe('内置工具集（builtinToolsets）', () => {
    beforeEach(() => {
      registerBuiltinToolsets();
    });

    it('应该注册 7 个内置工具集', () => {
      const ids = getToolsetRegistry().list();
      expect(ids).toContain('base');
      expect(ids).toContain('minimal');
      expect(ids).toContain('coding');
      expect(ids).toContain('desktop');
      expect(ids).toContain('daily');
      expect(ids).toContain('network');
      expect(ids).toContain('full');
    });

    it('base 工具集应包含记忆+认知+系统基础', () => {
      const resolved = getToolsetRegistry().resolve('base', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames).toContain('memory_recall');
      expect(resolved?.toolNames).toContain('self_reflect');
      expect(resolved?.toolNames).toContain('ask_clarification');
      expect(resolved?.toolNames).toContain('system_status');
    });

    it('coding 工具集应继承 base 并包含文件+代码工具', () => {
      const resolved = getToolsetRegistry().resolve('coding', toolRegistry);
      expect(resolved).toBeDefined();
      // 继承自 base
      expect(resolved?.toolNames).toContain('memory_recall');
      // 自身
      expect(resolved?.toolNames).toContain('file_read');
      expect(resolved?.toolNames).toContain('code_generate');
      expect(resolved?.toolNames).toContain('shell_exec');
      expect(resolved?.resolvedFrom).toContain('base');
      expect(resolved?.resolvedFrom).toContain('coding');
    });

    it('desktop 工具集应包含桌面工具', () => {
      const resolved = getToolsetRegistry().resolve('desktop', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames).toContain('desktop_automate');
      expect(resolved?.toolNames).toContain('desktop_screenshot');
    });

    it('daily 工具集应包含日常管理工具', () => {
      const resolved = getToolsetRegistry().resolve('daily', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames).toContain('task_manage');
      expect(resolved?.toolNames).toContain('reminder_set');
    });

    it('network 工具集应包含网络工具', () => {
      const resolved = getToolsetRegistry().resolve('network', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames).toContain('web_search');
      expect(resolved?.toolNames).toContain('web_fetch');
    });

    it('full 工具集应包含所有工具', () => {
      const resolved = getToolsetRegistry().resolve('full', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames.length).toBeGreaterThanOrEqual(15);
    });

    it('minimal 工具集应只包含认知+系统状态', () => {
      const resolved = getToolsetRegistry().resolve('minimal', toolRegistry);
      expect(resolved).toBeDefined();
      expect(resolved?.toolNames).toContain('self_reflect');
      expect(resolved?.toolNames).toContain('system_status');
      expect(resolved?.toolNames).not.toContain('file_read');
    });

    it('coding 工具集工具数应受 maxTools 限制', () => {
      const resolved = getToolsetRegistry().resolve('coding', toolRegistry);
      expect(resolved?.toolNames.length).toBeLessThanOrEqual(20);
    });
  });

  describe('Agent 角色映射', () => {
    it('coding Agent 应映射到 coding 工具集', () => {
      expect(getDefaultToolsetForAgent('coding')).toBe('coding');
    });

    it('desktop Agent 应映射到 desktop 工具集', () => {
      expect(getDefaultToolsetForAgent('desktop')).toBe('desktop');
    });

    it('orchestrator Agent 应映射到 full 工具集', () => {
      expect(getDefaultToolsetForAgent('orchestrator')).toBe('full');
    });

    it('未知 Agent 类型应降级到 base 工具集', () => {
      expect(getDefaultToolsetForAgent('unknown_type')).toBe('base');
    });

    it('AGENT_TOOLSET_MAP 应包含所有角色映射', () => {
      expect(AGENT_TOOLSET_MAP.coding).toBe('coding');
      expect(AGENT_TOOLSET_MAP.desktop).toBe('desktop');
      expect(AGENT_TOOLSET_MAP.daily).toBe('daily');
      expect(AGENT_TOOLSET_MAP.research).toBe('network');
      expect(AGENT_TOOLSET_MAP.orchestrator).toBe('full');
    });
  });

  describe('BUILTIN_TOOLSETS 常量', () => {
    it('应包含 7 个工具集定义', () => {
      expect(BUILTIN_TOOLSETS).toHaveLength(7);
    });

    it('每个工具集应有唯一 id', () => {
      const ids = BUILTIN_TOOLSETS.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });
});
