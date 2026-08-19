/**
 * Harness Tool: todo_manage - 任务清单管理
 *
 * 提供轻量级 TODO 列表管理，支持增删改查、优先级排序、
 * 标签分类、进度追踪。数据持久化到项目 .jiabaixing/todo.json。
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../../utils/Logger';
import type { ToolContext, ToolDefinition, ToolResult } from '../../types';
import { Permission, ToolCategory } from '../../types';

export const TODO_MANAGE_DEF: ToolDefinition = {
  name: 'todo_manage',
  description:
    '管理任务清单（TODO List）。支持操作：add（添加任务）、list（列出任务）、complete（标记完成）、remove（删除任务）、prioritize（调整优先级）、tag（添加标签）、clear（清空已完成）。适用场景：跟踪开发任务、管理待办事项、记录临时想法。',
  category: ToolCategory.SYSTEM,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型：add|list|complete|remove|prioritize|tag|clear',
      enum: ['add', 'list', 'complete', 'remove', 'prioritize', 'tag', 'clear'],
    },
    title: {
      type: 'string',
      description: '任务标题（add 操作必填）',
    },
    description: {
      type: 'string',
      description: '任务详细描述',
    },
    id: {
      type: 'string',
      description: '任务ID（complete/remove/prioritize/tag 操作必填）',
    },
    priority: {
      type: 'string',
      description: '优先级：low|medium|high|critical',
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    tags: {
      type: 'array',
      items: { type: 'string', description: '标签名' },
      description: '标签列表（tag 操作时使用）',
    },
    filter: {
      type: 'string',
      description: '过滤条件：all|pending|completed|tag:xxx|priority:xxx',
      default: 'pending',
    },
  },
  requiredParams: ['action'],
  requiredPermissions: [Permission.FILE_READ, Permission.FILE_WRITE],
  riskLevel: 'low',
  idempotent: true,
  timeout: 5000,
};

interface TodoItem {
  id: string;
  title: string;
  description?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'in_progress' | 'completed';
  tags: string[];
  createdAt: number;
  completedAt?: number;
}

interface TodoStore {
  items: TodoItem[];
  version: number;
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const PRIORITY_ICON: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

function getTodoFilePath(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const dir = path.join(root, '.jiabaixing');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'todo.json');
}

function loadStore(filePath: string): TodoStore {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // ignore parse errors
  }
  return { items: [], version: 1 };
}

function saveStore(filePath: string, store: TodoStore): void {
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

function generateId(): string {
  return `todo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function handleAdd(
  store: TodoStore,
  params: Record<string, unknown>,
  startTime: number
): ToolResult {
  const title = String(params.title || '').trim();
  if (!title) {
    return {
      success: false,
      output: '',
      error: '添加任务需要提供 title 参数',
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const item: TodoItem = {
    id: generateId(),
    title,
    description: params.description ? String(params.description) : undefined,
    priority: (params.priority as TodoItem['priority']) || 'medium',
    status: 'pending',
    tags: (params.tags as string[]) || [],
    createdAt: Date.now(),
  };

  store.items.push(item);

  const icon = PRIORITY_ICON[item.priority] || '⚪';
  return {
    success: true,
    output: `${icon} 任务已添加: [${item.id}] ${title} (优先级: ${item.priority})`,
    duration: Date.now() - startTime,
    validated: false,
    metadata: { id: item.id, priority: item.priority },
  };
}

function handleList(
  store: TodoStore,
  params: Record<string, unknown>,
  startTime: number
): ToolResult {
  const filter = String(params.filter || 'pending');
  let items = [...store.items];

  if (filter === 'pending') {
    items = items.filter((i) => i.status !== 'completed');
  } else if (filter === 'completed') {
    items = items.filter((i) => i.status === 'completed');
  } else if (filter.startsWith('tag:')) {
    const tag = filter.slice(4);
    items = items.filter((i) => i.tags.includes(tag));
  } else if (filter.startsWith('priority:')) {
    const pri = filter.slice(9);
    items = items.filter((i) => i.priority === pri);
  }

  items.sort(
    (a, b) =>
      (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0)
  );

  if (items.length === 0) {
    return {
      success: true,
      output:
        filter === 'all' ? '📋 任务清单为空' : `📋 没有匹配 "${filter}" 的任务`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const pending = store.items.filter((i) => i.status !== 'completed').length;
  const completed = store.items.filter((i) => i.status === 'completed').length;

  const lines = [`📋 任务清单 (${pending} 待办 / ${completed} 已完成)`, ''];

  for (const item of items) {
    const icon = PRIORITY_ICON[item.priority] || '⚪';
    const statusIcon =
      item.status === 'completed'
        ? '✅'
        : item.status === 'in_progress'
          ? '🔄'
          : '⬜';
    const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
    const desc = item.description
      ? ` — ${item.description.substring(0, 60)}`
      : '';
    lines.push(
      `${statusIcon} ${icon} [${item.id}] ${item.title}${tags}${desc}`
    );
  }

  return {
    success: true,
    output: lines.join('\n'),
    duration: Date.now() - startTime,
    validated: false,
    metadata: {
      total: items.length,
      pending,
      completed,
    },
  };
}

function handleComplete(
  store: TodoStore,
  params: Record<string, unknown>,
  startTime: number
): ToolResult {
  const id = String(params.id || '').trim();
  if (!id) {
    return {
      success: false,
      output: '',
      error: '需要提供 id 参数',
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const item = store.items.find((i) => i.id === id);
  if (!item) {
    return {
      success: false,
      output: '',
      error: `未找到任务: ${id}`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  item.status = 'completed';
  item.completedAt = Date.now();

  return {
    success: true,
    output: `✅ 任务已完成: [${item.id}] ${item.title}`,
    duration: Date.now() - startTime,
    validated: false,
    metadata: { id: item.id },
  };
}

function handleRemove(
  store: TodoStore,
  params: Record<string, unknown>,
  startTime: number
): ToolResult {
  const id = String(params.id || '').trim();
  if (!id) {
    return {
      success: false,
      output: '',
      error: '需要提供 id 参数',
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const index = store.items.findIndex((i) => i.id === id);
  if (index === -1) {
    return {
      success: false,
      output: '',
      error: `未找到任务: ${id}`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const removed = store.items.splice(index, 1)[0];

  return {
    success: true,
    output: `🗑️ 任务已删除: [${removed.id}] ${removed.title}`,
    duration: Date.now() - startTime,
    validated: false,
  };
}

function handlePrioritize(
  store: TodoStore,
  params: Record<string, unknown>,
  startTime: number
): ToolResult {
  const id = String(params.id || '').trim();
  const priority = String(params.priority || '').trim();

  if (!id || !priority) {
    return {
      success: false,
      output: '',
      error: '需要提供 id 和 priority 参数',
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const validPriorities = ['low', 'medium', 'high', 'critical'];
  if (!validPriorities.includes(priority)) {
    return {
      success: false,
      output: '',
      error: `无效优先级: ${priority}。支持: ${validPriorities.join(', ')}`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const item = store.items.find((i) => i.id === id);
  if (!item) {
    return {
      success: false,
      output: '',
      error: `未找到任务: ${id}`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const oldPriority = item.priority;
  item.priority = priority as TodoItem['priority'];

  const icon = PRIORITY_ICON[priority] || '⚪';
  return {
    success: true,
    output: `${icon} 优先级已调整: [${item.id}] ${item.title} (${oldPriority} → ${priority})`,
    duration: Date.now() - startTime,
    validated: false,
  };
}

function handleTag(
  store: TodoStore,
  params: Record<string, unknown>,
  startTime: number
): ToolResult {
  const id = String(params.id || '').trim();
  const tags = (params.tags as string[]) || [];

  if (!id || tags.length === 0) {
    return {
      success: false,
      output: '',
      error: '需要提供 id 和 tags 参数',
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const item = store.items.find((i) => i.id === id);
  if (!item) {
    return {
      success: false,
      output: '',
      error: `未找到任务: ${id}`,
      duration: Date.now() - startTime,
      validated: false,
    };
  }

  const added: string[] = [];
  for (const tag of tags) {
    if (!item.tags.includes(tag)) {
      item.tags.push(tag);
      added.push(tag);
    }
  }

  return {
    success: true,
    output: `🏷️ 标签已更新: [${item.id}] ${item.title} — 当前标签: [${item.tags.join(', ')}]`,
    duration: Date.now() - startTime,
    validated: false,
    metadata: { addedTags: added, allTags: item.tags },
  };
}

function handleClear(store: TodoStore, startTime: number): ToolResult {
  const before = store.items.length;
  store.items = store.items.filter((i) => i.status !== 'completed');
  const removed = before - store.items.length;

  return {
    success: true,
    output:
      removed > 0
        ? `🧹 已清除 ${removed} 个已完成任务`
        : '没有已完成的任务需要清除',
    duration: Date.now() - startTime,
    validated: false,
    metadata: { removed },
  };
}

export function createTodoManageExecutor(deps?: { projectRoot?: string }) {
  return async (
    params: Record<string, unknown>,
    _context?: ToolContext
  ): Promise<ToolResult> => {
    const startTime = Date.now();
    const action = String(params.action || '');

    const filePath = getTodoFilePath(deps?.projectRoot);
    const store = loadStore(filePath);

    let result: ToolResult;

    switch (action) {
      case 'add':
        result = handleAdd(store, params, startTime);
        break;
      case 'list':
        result = handleList(store, params, startTime);
        break;
      case 'complete':
        result = handleComplete(store, params, startTime);
        break;
      case 'remove':
        result = handleRemove(store, params, startTime);
        break;
      case 'prioritize':
        result = handlePrioritize(store, params, startTime);
        break;
      case 'tag':
        result = handleTag(store, params, startTime);
        break;
      case 'clear':
        result = handleClear(store, startTime);
        break;
      default:
        result = {
          success: false,
          output: '',
          error: `不支持的操作: ${action}。支持: add, list, complete, remove, prioritize, tag, clear`,
          duration: Date.now() - startTime,
          validated: false,
        };
    }

    if (result.success) {
      saveStore(filePath, store);
      Logger.info(`📝 todo_manage ${action}: 成功`, 'TodoManage');
    }

    return result;
  };
}
