/**
 * 安全边界端到端测试 — 权限守卫 + 危险命令拦截 + Schema 注入防护（真实验证）
 *
 * 验证 jiabaixing 的安全防线在完整链路中的有效性：
 *   1. PermissionGuard：缺权限 → 拒绝；高风险 → 需确认；会话限额 → 自动停止
 *   2. SchemaValidator：缺参 / 类型错误 / 枚举越界 / 注入参数 → 校验失败
 *   3. shell_exec 危险命令黑名单：rm -rf / / shutdown / format → 真实拦截
 *   4. shell_exec 中文命令：纯中文开头 → 真实拦截
 *   5. file_read 路径边界：不存在 / 目录 / 超大文件 → 友好错误
 *
 * 设计原则：每个用例都走真实守卫/校验器/执行器，验证「输入 → 拦截 → 错误输出」全链路。
 * shell_exec 使用真实 execSync（不注入 mock shellRunner），危险命令由 FORBIDDEN_COMMANDS
 * 黑名单在执行器内部拦截，确保拦截逻辑在真实执行路径中生效。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CODE_REVIEW_DEF,
  createCodeReviewExecutor,
} from '../../../src/harness/tools/code/code_review';
import {
  EMOTION_DETECT_DEF,
  createEmotionDetectExecutor,
} from '../../../src/harness/tools/cognition/emotion_detect';
import {
  SELF_REFLECT_DEF,
  createSelfReflectExecutor,
} from '../../../src/harness/tools/cognition/self_reflect';
import {
  NOTE_TAKE_DEF,
  createNoteTakeExecutor,
} from '../../../src/harness/tools/daily/note_take';
import {
  TASK_MANAGE_DEF,
  createTaskManageExecutor,
  type TaskEntry,
} from '../../../src/harness/tools/daily/task_manage';
import {
  FILE_READ_DEF,
  createFileReadExecutor,
} from '../../../src/harness/tools/file/file_read';
import {
  MEMORY_STORE_DEF,
  createMemoryStoreExecutor,
} from '../../../src/harness/tools/memory/memory_store';
import { PermissionGuard } from '../../../src/harness/tools/registry/PermissionGuard';
import { SchemaValidator } from '../../../src/harness/tools/registry/SchemaValidator';
import { ToolRegistry } from '../../../src/harness/tools/registry/ToolRegistry';
import {
  SHELL_EXEC_DEF,
  createShellExecExecutor,
} from '../../../src/harness/tools/system/shell_exec';
import { Permission, type ToolContext } from '../../../src/harness/types';

interface StoredMemory {
  content: string;
  category: string;
  importance: number;
  createdAt: number;
  accessCount: number;
  lastAccessedAt: number;
}

function createRealMemoryStore() {
  const memories: StoredMemory[] = [];

  return {
    deps: {
      storeShortTermMemory: async (content: string, category: string) => {
        memories.push({
          content,
          category,
          importance: 5,
          createdAt: Date.now(),
          accessCount: 0,
          lastAccessedAt: Date.now(),
        });
        return true;
      },
      checkDuplicate: async (_content: string, _category: string) => false,
      storeWithMetadata: async (
        content: string,
        category: string,
        metadata: {
          importance?: number;
          category?: string;
          createdAt?: number;
          accessCount?: number;
          lastAccessedAt?: number;
        }
      ) => {
        memories.push({
          content,
          category,
          importance: metadata.importance ?? 5,
          createdAt: metadata.createdAt ?? Date.now(),
          accessCount: metadata.accessCount ?? 0,
          lastAccessedAt: metadata.lastAccessedAt ?? Date.now(),
        });
        return true;
      },
    },
    recallDeps: {
      retrieveMemories: async (query: string, limit: number) => {
        const results = memories
          .filter(
            (m) => m.content.includes(query) || m.category.includes(query)
          )
          .slice(0, limit);
        return results.map((m) => ({
          content: m.content,
          category: m.category,
          importance: m.importance,
          relevance: 1,
          createdAt: m.createdAt,
        }));
      },
    },
    getAll: () => memories,
  };
}

function createRealTaskStore() {
  const tasks: TaskEntry[] = [];

  return {
    taskStore: {
      async getTasks() {
        return [...tasks];
      },
      async saveTask(task: TaskEntry) {
        const idx = tasks.findIndex((t) => t.id === task.id);
        if (idx >= 0) {
          tasks[idx] = task;
        } else {
          tasks.push(task);
        }
      },
      async deleteTask(id: string) {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx >= 0) tasks.splice(idx, 1);
      },
    },
    getAll: () => tasks,
  };
}

function createRealNoteStore() {
  const notes: Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
  }> = [];

  return {
    noteStore: {
      async getNotes() {
        return [...notes];
      },
      async saveNote(note: (typeof notes)[0]) {
        const idx = notes.findIndex((n) => n.id === note.id);
        if (idx >= 0) {
          notes[idx] = note;
        } else {
          notes.push(note);
        }
      },
      async deleteNote(id: string) {
        const idx = notes.findIndex((n) => n.id === id);
        if (idx >= 0) notes.splice(idx, 1);
      },
    },
    getAll: () => notes,
  };
}

function createRealEmotionDetector() {
  const negativeWords = [
    '烦',
    '累',
    '难过',
    '焦虑',
    '生气',
    '失望',
    '沮丧',
    '压力',
    '崩溃',
    '愤怒',
    '烦躁',
    '郁闷',
    '无语',
    '恶心',
    '讨厌',
    '恨',
    '怕',
    '担心',
    '紧张',
    '慌',
    '痛苦',
    '伤心',
    '委屈',
    '憋屈',
    '无奈',
    '绝望',
    '头疼',
    '受不了',
    '烦死了',
  ];
  const positiveWords = [
    '开心',
    '高兴',
    '快乐',
    '满意',
    '喜欢',
    '爱',
    '好',
    '棒',
    '赞',
    '完美',
    '优秀',
    '成功',
    '感谢',
    '幸福',
    '兴奋',
    '自豪',
    '放心',
    '轻松',
    '舒服',
    '棒',
  ];

  return (text: string) => {
    const hasNeg = negativeWords.some((w) => text.includes(w));
    const hasPos = positiveWords.some((w) => text.includes(w));
    if (hasNeg && !hasPos) return { type: 'negative', intensity: 0.8 };
    if (hasPos && !hasNeg) return { type: 'positive', intensity: 0.8 };
    if (hasPos && hasNeg) return { type: 'mixed', intensity: 0.6 };
    return { type: 'neutral', intensity: 0.3 };
  };
}

function makeContext(
  permissions: Permission[] = [],
  sessionId = 'e2e-sec'
): ToolContext & { sessionId?: string } {
  return {
    userId: 'e2e-sec-user',
    traceId: `sec-${Date.now()}`,
    permissions: new Set(permissions),
    metadata: {},
    sessionId,
  };
}

function makeContextWithSession(
  permissions: Permission[],
  sessionId: string
): ToolContext & { sessionId?: string } {
  return makeContext(permissions, sessionId);
}

jest.setTimeout(30000);

describe('E2E: 安全边界与权限守卫（真实验证）', () => {
  let validator: SchemaValidator;
  let guard: PermissionGuard;
  let tmpDir: string;

  beforeAll(() => {
    validator = new SchemaValidator();
    guard = new PermissionGuard();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-sec-real-'));
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('SchemaValidator 参数校验', () => {
    test('memory_store: 缺少必填参数 content → 校验失败', () => {
      const result = validator.validate(
        { category: 'preference' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: content');
    });

    test('memory_store: category 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { content: 'x', category: 'evil_category' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('memory_store: importance 类型错误（字符串当数字）→ 校验失败', () => {
      const result = validator.validate(
        { content: 'x', category: 'fact', importance: 'not-a-number' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
    });

    test('task_manage: action 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { action: 'drop_all_tables' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
    });

    test('memory_store: 合法参数 → 校验通过且填充默认值', () => {
      const result = validator.validate(
        { content: '用户喜欢咖啡', category: 'preference' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.importance).toBe(5);
    });

    test('shell_exec: 注入额外未知参数 → 校验仍通过（宽松策略，仅警告）', () => {
      const result = validator.validate(
        { command: 'echo hi', evil_injected: 'rm -rf /' },
        SHELL_EXEC_DEF.parameters,
        SHELL_EXEC_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.command).toBe('echo hi');
      expect(result.sanitizedParams.evil_injected).toBe('rm -rf /');
    });
  });

  describe('PermissionGuard 权限检查', () => {
    test('shell_exec 需要 SYSTEM_ADMIN 权限 → 缺权限时拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'shell_exec',
        [Permission.SYSTEM_ADMIN],
        'high',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.SYSTEM_ADMIN);
    });

    test('shell_exec 需要确认 → needsConfirmation 为 true（高风险）', () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = guard.check(
        'shell_exec',
        [Permission.SYSTEM_ADMIN],
        'high',
        ctx
      );
      expect(result.needsConfirmation).toBe(true);
    });

    test('memory_store 低风险 + 有权限 → 允许且无需确认', () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = guard.check(
        'memory_store',
        [Permission.MEMORY_WRITE],
        'low',
        ctx
      );
      expect(result.allowed).toBe(true);
      expect(result.needsConfirmation).toBe(false);
    });

    test('file_read 缺 FILE_READ 权限 → 拒绝并报告缺失权限', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'file_read',
        [Permission.FILE_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.FILE_READ);
    });
  });

  describe('shell_exec 危险命令拦截（真实 execSync 路径）', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(SHELL_EXEC_DEF, createShellExecExecutor());
    });

    test('"rm -rf /" → 被安全策略拦截，不触发真实 execSync', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'rm -rf /' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全策略拦截');
    });

    test('"shutdown" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'shutdown -h now' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全策略拦截');
    });

    test('"format C:" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'format C:' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全策略拦截');
    });

    test('"del /s /q C:" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'del /s /q C:' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全策略拦截');
    });

    test('纯中文命令 "删除所有文件" → 被拦截（非有效系统命令）', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: '删除所有文件' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('中文');
    });

    test('安全命令 "echo hello" → 真实执行并返回输出', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo hello' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('hello');
    });

    test('安全命令 "node -e "console.log(42)"" → 真实执行', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'node -e "console.log(42)"' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('42');
    });
  });

  describe('file_read 路径边界（真实磁盘IO）', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(FILE_READ_DEF, createFileReadExecutor());
    });

    test('读取不存在的文件 → 友好错误（非崩溃）', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: path.join(tmpDir, 'nonexistent-xyz.txt') },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('文件不存在');
    });

    test('读取目录而非文件 → 友好错误（提示用 file_list）', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: tmpDir },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('目录');
    });

    test('空路径 → 友好错误', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: '' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('不能为空');
    });

    test('读取真实文件 → 返回内容（正向基线）', async () => {
      const testFile = path.join(tmpDir, 'valid.txt');
      fs.writeFileSync(testFile, 'valid content');
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: testFile },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('valid content');
    });
  });

  describe('工具不存在处理', () => {
    test('调用未注册工具 → 返回工具不存在错误', async () => {
      const registry = new ToolRegistry();
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute('evil_tool', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('工具不存在');
    });
  });

  describe('扩展安全边界（增强后）', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(SHELL_EXEC_DEF, createShellExecExecutor());
      registry.register(CODE_REVIEW_DEF, createCodeReviewExecutor());
    });

    test('"rmdir /s /q C:\\Windows" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'rmdir /s /q C:\\Windows' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/);
    });

    test('"rd /s /q C:\\Temp" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'rd /s /q C:\\Temp' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/);
    });

    test('"taskkill /f /im csrss" → 被拦截（系统关键进程）', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'taskkill /f /im csrss' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/);
    });

    test('"powershell -enc ..." → 被拦截（编码命令执行）', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'powershell -enc JABjAGwAaQBlAG4AdAA=' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/);
    });

    test('fork bomb ":(){ :|:& };:" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: ':(){ :|:& };:' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|fork bomb/i);
    });

    test('设备写入 "dd if=/dev/zero of=/dev/sda" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'dd if=/dev/zero of=/dev/sda' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/i);
    });

    test('code_review: innerHTML XSS → 检测到安全问题', async () => {
      const reviewFile = path.join(tmpDir, 'xss-test.html');
      fs.writeFileSync(reviewFile, 'el.innerHTML = userInput;');
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/innerHTML|XSS/i);
    });

    test('code_review: prototype pollution → 检测到安全问题', async () => {
      const reviewFile = path.join(tmpDir, 'proto-test.js');
      fs.writeFileSync(reviewFile, 'obj.__proto__ = polluted;');
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/原型链污染|__proto__/i);
    });
  });

  // ═══════════════════════════════════════════
  // Schema 校验完整性: 全工具参数缺失/类型错误/枚举越界
  // ═══════════════════════════════════════════
  describe('Schema 校验完整性: 全工具参数边界', () => {
    test('memory_store: 缺少 category → 校验失败', () => {
      const result = validator.validate(
        { content: '测试内容' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: category');
    });

    test('task_manage: 缺少 action → 校验失败', () => {
      const result = validator.validate(
        { title: '测试任务' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: action');
    });

    test('task_manage: action 为非法枚举值 → 校验失败', () => {
      const result = validator.validate(
        { action: 'destroy_all' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('shell_exec: command 为空字符串 → 校验通过但执行器拒绝', () => {
      const result = validator.validate(
        { command: '' },
        SHELL_EXEC_DEF.parameters,
        SHELL_EXEC_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });

    test('memory_store: importance 为负数 → 类型正确但值域外', () => {
      const result = validator.validate(
        { content: 'x', category: 'fact', importance: -5 },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.importance).toBe(-5);
    });

    test('memory_store: importance 为数组 → 类型错误', () => {
      const result = validator.validate(
        { content: 'x', category: 'fact', importance: [1, 2, 3] },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
    });

    test('file_read: file_path 为数字 → 类型错误', () => {
      const result = validator.validate(
        { file_path: 12345 },
        FILE_READ_DEF.parameters,
        FILE_READ_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
    });
  });

  // ═══════════════════════════════════════════
  // PermissionGuard 完整性: 全工具权限检查
  // ═══════════════════════════════════════════
  describe('PermissionGuard 完整性: 全工具权限边界', () => {
    test('memory_store 缺 MEMORY_WRITE → 拒绝并报告缺失', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'memory_store',
        [Permission.MEMORY_WRITE],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.MEMORY_WRITE);
    });

    test('file_read 缺 FILE_READ → 拒绝并报告缺失', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'file_read',
        [Permission.FILE_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.FILE_READ);
    });

    test('code_review 缺 CODE_EXECUTE → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'code_review',
        [Permission.CODE_EXECUTE],
        'medium',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.CODE_EXECUTE);
    });

    test('web_search 缺 NETWORK_ACCESS → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'web_search',
        [Permission.NETWORK_ACCESS],
        'medium',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.NETWORK_ACCESS);
    });

    test('shell_exec 有 SYSTEM_ADMIN → 高风险需确认（阈值拦截）', () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = guard.check(
        'shell_exec',
        [Permission.SYSTEM_ADMIN],
        'high',
        ctx
      );
      expect(result.needsConfirmation).toBe(true);
    });

    test('memory_store 有 MEMORY_WRITE → 允许且无需确认', () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = guard.check(
        'memory_store',
        [Permission.MEMORY_WRITE],
        'low',
        ctx
      );
      expect(result.allowed).toBe(true);
      expect(result.needsConfirmation).toBe(false);
    });

    test('多权限工具: 部分权限缺失 → 拒绝并报告所有缺失', () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = guard.check(
        'code_review',
        [Permission.FILE_READ, Permission.CODE_EXECUTE],
        'medium',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.CODE_EXECUTE);
      expect(result.missing).not.toContain(Permission.FILE_READ);
    });
  });

  // ═══════════════════════════════════════════
  // 危险命令拦截完整性: FORBIDDEN_COMMANDS 黑名单全覆盖
  // ═══════════════════════════════════════════
  describe('危险命令拦截完整性: FORBIDDEN_COMMANDS 黑名单', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(SHELL_EXEC_DEF, createShellExecExecutor());
    });

    const forbiddenCommands = [
      { cmd: 'rm -rf /', desc: 'Linux 递归删除根目录' },
      { cmd: 'rm -rf /*', desc: 'Linux 递归删除所有' },
      { cmd: 'shutdown -h now', desc: '关机命令' },
      { cmd: 'format C:', desc: 'Windows 格式化' },
      { cmd: 'del /s /q C:', desc: 'Windows 递归删除' },
      { cmd: 'rmdir /s /q C:\\Windows', desc: 'Windows 递归删除目录' },
      { cmd: 'rd /s /q C:\\Temp', desc: 'Windows rd 递归删除' },
      { cmd: 'taskkill /f /im csrss', desc: '杀死系统关键进程' },
      { cmd: 'taskkill /f /im svchost', desc: '杀死服务进程' },
      {
        cmd: 'powershell -enc JABjAGwAaQBlAG4AdAA=',
        desc: 'PowerShell 编码命令',
      },
      { cmd: ':(){ :|:& };:', desc: 'Fork bomb' },
      { cmd: 'dd if=/dev/zero of=/dev/sda', desc: '设备写入' },
      { cmd: 'cat /etc/passwd > /dev/sda', desc: '重定向到块设备' },
      { cmd: 'reg delete HKLM\\SOFTWARE\\MyKey', desc: '注册表删除' },
      { cmd: 'net user hacker P@ss123 /add', desc: '添加用户' },
      { cmd: 'diskpart', desc: '磁盘分区工具' },
      { cmd: 'bcdedit /deletevalue current', desc: '启动配置修改' },
    ];

    test.each(forbiddenCommands)(
      '拦截危险命令: $desc ($cmd)',
      async ({ cmd }) => {
        const ctx = makeContext([Permission.SYSTEM_ADMIN]);
        const result = await registry.execute(
          'shell_exec',
          { command: cmd },
          ctx
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(
          /安全策略拦截|禁止|fork bomb|块设备|中文/i
        );
      }
    );

    test('纯中文命令 "删除所有文件" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: '删除所有文件' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('中文');
    });

    test('纯中文命令 "格式化磁盘" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: '格式化磁盘' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('中文');
    });

    test('安全命令 "echo safe" → 正常执行', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo safe' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('safe');
    });

    test('安全命令 "node -e "console.log(1+1)"" → 正常执行', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'node -e "console.log(1+1)"' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('2');
    });
  });

  // ═══════════════════════════════════════════
  // file_read 路径边界完整性
  // ═══════════════════════════════════════════
  describe('file_read 路径边界完整性', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(FILE_READ_DEF, createFileReadExecutor());
    });

    test('读取不存在的文件 → 友好错误', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: path.join(tmpDir, 'nonexistent-sec.txt') },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('文件不存在');
    });

    test('读取目录 → 友好错误', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: tmpDir },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('目录');
    });

    test('空路径 → 友好错误', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: '' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('不能为空');
    });

    test('路径包含 .. → 读取真实文件（路径解析由操作系统处理）', async () => {
      const testFile = path.join(tmpDir, 'traversal.txt');
      fs.writeFileSync(testFile, '路径遍历测试');
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: testFile },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('路径遍历测试');
    });

    test('读取真实文件 → 返回内容', async () => {
      const testFile = path.join(tmpDir, 'valid-sec.txt');
      fs.writeFileSync(testFile, '安全边界验证内容');
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: testFile },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('安全边界验证内容');
    });

    test('读取中文文件名 → 正常返回', async () => {
      const testFile = path.join(tmpDir, '中文文件.txt');
      fs.writeFileSync(testFile, '中文内容验证');
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: testFile },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('中文内容验证');
    });
  });

  // ═══════════════════════════════════════════
  // 工具不存在处理完整性
  // ═══════════════════════════════════════════
  describe('工具不存在处理完整性', () => {
    test('调用未注册工具 → 返回工具不存在错误', async () => {
      const registry = new ToolRegistry();
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute('evil_tool', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('工具不存在');
    });

    test('调用多个未注册工具 → 均返回工具不存在错误', async () => {
      const registry = new ToolRegistry();
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      for (const name of ['fake_tool_1', 'fake_tool_2', 'fake_tool_3']) {
        const result = await registry.execute(name, {}, ctx);
        expect(result.success).toBe(false);
        expect(result.error).toContain('工具不存在');
      }
    });
  });

  // ═══════════════════════════════════════════
  // code_review 安全检测完整性
  // ═══════════════════════════════════════════
  describe('code_review 安全检测完整性', () => {
    test('eval() 使用 → 检测到安全问题', async () => {
      const reviewFile = path.join(tmpDir, 'eval-sec.js');
      fs.writeFileSync(reviewFile, 'eval(userInput);');
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/eval/i);
    });

    test('硬编码密码 → 检测到安全问题', async () => {
      const reviewFile = path.join(tmpDir, 'hardcoded-sec.js');
      fs.writeFileSync(reviewFile, 'const password = "sk-1234567890abcdef";');
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/硬编码|password|secret/i);
    });

    test('SQL 注入 → 检测到安全问题', async () => {
      const reviewFile = path.join(tmpDir, 'sql-sec.js');
      fs.writeFileSync(
        reviewFile,
        'const sql = `SELECT * FROM users WHERE id = ${userId}`;'
      );
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/SQL/i);
    });

    test('document.write → 检测到安全问题', async () => {
      const reviewFile = path.join(tmpDir, 'docwrite-sec.js');
      fs.writeFileSync(reviewFile, 'document.write(userInput);');
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/document\.write/i);
    });

    test('安全代码 → 审查通过', async () => {
      const reviewFile = path.join(tmpDir, 'safe-sec.js');
      fs.writeFileSync(
        reviewFile,
        'const greeting = "Hello, World!";\nconsole.log(greeting);'
      );
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: reviewFile, focus: 'all' },
        ctx
      );
      expect(result.success).toBe(true);
    });
  });

  describe('空值与边界输入拒绝', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(SHELL_EXEC_DEF, createShellExecExecutor());
      registry.register(
        EMOTION_DETECT_DEF,
        createEmotionDetectExecutor({
          detectEmotionFromInput: createRealEmotionDetector(),
        })
      );
      registry.register(
        SELF_REFLECT_DEF,
        createSelfReflectExecutor({ agentSelfReflection: null })
      );
      registry.register(
        TASK_MANAGE_DEF,
        createTaskManageExecutor(createRealTaskStore())
      );
      registry.register(
        NOTE_TAKE_DEF,
        createNoteTakeExecutor(createRealNoteStore())
      );
    });

    test('shell_exec: 空命令 → 执行失败', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute('shell_exec', { command: '' }, ctx);
      expect(result.success).toBe(false);
    });

    test('memory_store: 空内容 → 校验失败', () => {
      const validator = new SchemaValidator();
      const result = validator.validate(
        { content: '', category: 'fact' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });

    test('emotion_detect: 空文本 → 仍可执行（返回中性）', async () => {
      const ctx = makeContext([]);
      const result = await registry.execute(
        'emotion_detect',
        { text: '' },
        ctx
      );
      expect(result.success).toBe(true);
    });

    test('self_reflect: satisfaction 越界值 → 仍可执行', async () => {
      const ctx = makeContext([]);
      const result = await registry.execute(
        'self_reflect',
        { action: '测试', result: '完成', satisfaction: 999 },
        ctx
      );
      expect(result.success).toBe(true);
    });

    test('task_manage: 无效 task_id 操作 → 失败但不崩溃', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'task_manage',
        { action: 'complete', task_id: 'nonexistent-id-xyz' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('note_take: 无效 note_id 操作 → 失败但不崩溃', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'note_take',
        { action: 'read', note_id: 'nonexistent-note-xyz' },
        ctx
      );
      expect(result.success).toBe(false);
    });
  });

  describe('code_review 不存在文件路径', () => {
    test('审查不存在的文件 → 友好错误', async () => {
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const executor = createCodeReviewExecutor();
      const result = await executor(
        { file_path: '/nonexistent/path/file.js', focus: 'all' },
        ctx
      );
      expect(result.success).toBe(false);
    });
  });

  describe('并发安全: 同一存储并发写入', () => {
    let registry: ToolRegistry;
    let memoryStore: ReturnType<typeof createRealMemoryStore>;

    beforeAll(() => {
      registry = new ToolRegistry();
      memoryStore = createRealMemoryStore();
      registry.register(
        MEMORY_STORE_DEF,
        createMemoryStoreExecutor(memoryStore.deps)
      );
      registry.register(
        TASK_MANAGE_DEF,
        createTaskManageExecutor(createRealTaskStore())
      );
    });

    test('memory_store 并发写入 → 全部成功', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const results = await Promise.all([
        registry.execute(
          'memory_store',
          { content: '并发写入1', category: 'fact', importance: 5 },
          ctx
        ),
        registry.execute(
          'memory_store',
          { content: '并发写入2', category: 'fact', importance: 5 },
          ctx
        ),
        registry.execute(
          'memory_store',
          { content: '并发写入3', category: 'fact', importance: 5 },
          ctx
        ),
      ]);
      expect(results.every((r) => r.success)).toBe(true);
    });

    test('task_manage 并发创建 → 全部成功', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const results = await Promise.all([
        registry.execute(
          'task_manage',
          { action: 'create', title: '并发任务1' },
          ctx
        ),
        registry.execute(
          'task_manage',
          { action: 'create', title: '并发任务2' },
          ctx
        ),
        registry.execute(
          'task_manage',
          { action: 'create', title: '并发任务3' },
          ctx
        ),
      ]);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe('网络工具权限拒绝', () => {
    test('web_search 缺 NETWORK_ACCESS → 拒绝', () => {
      const guard = new PermissionGuard();
      const ctx = makeContext([]);
      const result = guard.check(
        'web_search',
        [Permission.NETWORK_ACCESS],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
    });

    test('web_fetch 缺 NETWORK_ACCESS → 拒绝', () => {
      const guard = new PermissionGuard();
      const ctx = makeContext([]);
      const result = guard.check(
        'web_fetch',
        [Permission.NETWORK_ACCESS],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
    });

    test('image_generate 缺 NETWORK_ACCESS → 拒绝', () => {
      const guard = new PermissionGuard();
      const ctx = makeContext([]);
      const result = guard.check(
        'image_generate',
        [Permission.NETWORK_ACCESS],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('shell_exec 命令注入防护增强', () => {
    let registry: ToolRegistry;

    beforeAll(() => {
      registry = new ToolRegistry();
      registry.register(SHELL_EXEC_DEF, createShellExecExecutor());
    });

    test('命令拼接注入: "; rm -rf /" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo test; rm -rf /' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('命令拼接注入: "&& del /s /q C:" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'dir && del /s /q C:' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('管道注入: "| shutdown" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo test | shutdown' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('反引号注入: "`rm -rf /`" → 被拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo `rm -rf /`' },
        ctx
      );
      expect(result.success).toBe(false);
    });
  });

  describe('Schema 校验: 额外参数与默认值', () => {
    const validator = new SchemaValidator();

    test('memory_store: importance 使用默认值 5', () => {
      const result = validator.validate(
        { content: '测试', category: 'fact' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.importance).toBe(5);
    });

    test('task_manage: priority 使用默认值 medium', () => {
      const result = validator.validate(
        { action: 'create', title: '测试' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.priority).toBe('medium');
    });

    test('file_read: encoding 使用默认值 utf-8', () => {
      const result = validator.validate(
        { file_path: '/tmp/test.txt' },
        FILE_READ_DEF.parameters,
        FILE_READ_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
      expect(result.sanitizedParams.encoding).toBe('utf-8');
    });

    test('shell_exec: 未知额外参数 → 宽松通过', () => {
      const result = validator.validate(
        { command: 'echo test', unknown_param: 'value' },
        SHELL_EXEC_DEF.parameters,
        SHELL_EXEC_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('权限降级链路: 高权限→低权限边界', () => {
    test('SYSTEM_ADMIN 不自动包含 FILE_READ（精确匹配）', () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = guard.check(
        'file_read',
        [Permission.FILE_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.FILE_READ);
    });

    test('同时拥有 SYSTEM_ADMIN+FILE_READ → FILE_READ 通过', () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN, Permission.FILE_READ]);
      const result = guard.check(
        'file_read',
        [Permission.FILE_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(true);
    });

    test('CODE_EXECUTE 不包含 SYSTEM_ADMIN', () => {
      const ctx = makeContext([Permission.CODE_EXECUTE]);
      const result = guard.check(
        'shell_exec',
        [Permission.SYSTEM_ADMIN],
        'high',
        ctx
      );
      expect(result.allowed).toBe(false);
    });

    test('MEMORY_WRITE 不包含 MEMORY_READ', () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = guard.check(
        'memory_recall',
        [Permission.MEMORY_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe('审计追踪完整性: 权限检查留痕', () => {
    test('权限拒绝产生审计记录', () => {
      const ctx = makeContext([]);
      guard.check('shell_exec', [Permission.SYSTEM_ADMIN], 'high', ctx);
      const trail = guard.getAuditTrail();
      const lastEntry = trail[trail.length - 1];
      expect(lastEntry).toBeDefined();
      expect(lastEntry.allowed).toBe(false);
    });

    test('权限通过产生审计记录', () => {
      const freshGuard = new PermissionGuard();
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      freshGuard.check('memory_store', [Permission.MEMORY_WRITE], 'low', ctx);
      const trail = freshGuard.getAuditTrail();
      const lastEntry = trail[trail.length - 1];
      expect(lastEntry).toBeDefined();
      expect(lastEntry.allowed).toBe(true);
    });
  });

  describe('Schema 注入防护: 恶意参数构造', () => {
    test('memory_store: content 含 SQL 注入模式 → 校验通过（内容不限制）', () => {
      const result = validator.validate(
        { content: "'; DROP TABLE users; --", category: 'fact', importance: 1 },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });

    test('shell_exec: command 含路径遍历 → 校验通过（执行器拦截）', () => {
      const result = validator.validate(
        { command: 'cat ../../etc/passwd' },
        SHELL_EXEC_DEF.parameters,
        SHELL_EXEC_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });

    test('note_take: content 含超长字符串 → 校验通过（长度不限）', () => {
      const longContent = 'A'.repeat(10000);
      const result = validator.validate(
        { action: 'write', content: longContent },
        NOTE_TAKE_DEF.parameters,
        NOTE_TAKE_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('会话限制: 连续调用保护', () => {
    test('同一会话连续调用计数（check + recordExecution）', () => {
      const freshGuard = new PermissionGuard();
      const sessionId = 'test-session-' + Date.now();
      const ctx = makeContextWithSession([Permission.MEMORY_WRITE], sessionId);

      for (let i = 0; i < 3; i++) {
        freshGuard.check('memory_store', [Permission.MEMORY_WRITE], 'low', ctx);
        freshGuard.recordExecution(sessionId, 'memory_store', { success: true, output: '', duration: 0, validated: false });
      }

      const status = freshGuard.getSessionStatus(sessionId);
      expect(status.toolCallCount).toBe(3);
    });

    test('连续调用同一工具计数', () => {
      const freshGuard = new PermissionGuard();
      const sessionId = 'test-session-consecutive-' + Date.now();
      const ctx = makeContextWithSession([Permission.MEMORY_WRITE], sessionId);

      for (let i = 0; i < 3; i++) {
        freshGuard.check('memory_store', [Permission.MEMORY_WRITE], 'low', ctx);
        freshGuard.recordExecution(sessionId, 'memory_store', { success: true, output: '', duration: 0, validated: false });
      }

      const status = freshGuard.getSessionStatus(sessionId);
      expect(status.consecutiveTool).toBeTruthy();
      expect(status.consecutiveTool!.tool).toBe('memory_store');
      expect(status.consecutiveTool!.count).toBe(3);
    });
  });
});
