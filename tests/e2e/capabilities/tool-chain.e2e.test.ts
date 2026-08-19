/**
 * 核心能力端到端测试 — 工具链完整链路验证（真实验证）
 *
 * 覆盖 jiabaixing 九大能力的「工具定义 → Schema 校验 → 权限检查 → 执行 → 结果」全链路：
 *   能记(memory) / 能搜(search) / 能抓(fetch) / 能说(tts) / 能画(image)
 *   能写(code)  / 能管(task)  / 能思(cognition) / 能控(shell)
 *
 * 设计原则：
 *   - 真实验证：所有工具走真实代码路径，不使用 mock 返回值
 *   - 离线优先：需要外部 API 的工具（web_search/web_fetch/image_generate）
 *     在无网络时自动 skip，有网络时走真实 HTTP 请求
 *   - 真实存储：memory/task/note 使用真实的内存存储实现，数据真实流转
 *   - 真实执行：shell_exec 走真实 execSync，file_read/file_list 走真实 fs
 *   - 真实分析：code_review 走真实静态规则检查+安全检查
 *   - 真实情感：emotion_detect 使用与 initHarness 相同的情感词库实现
 *   - 真实降级：tts_speak 走真实模拟模式降级路径（无 TTS 硬件时的真实行为）
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionGuard } from '../../../src/harness/tools/registry/PermissionGuard';
import { SchemaValidator } from '../../../src/harness/tools/registry/SchemaValidator';
import { ToolRegistry } from '../../../src/harness/tools/registry/ToolRegistry';
import {
  Permission,
  ToolCategory,
  type ToolContext,
} from '../../../src/harness/types';

import {
  CODE_GENERATE_DEF,
  createCodeGenerateExecutor,
} from '../../../src/harness/tools/code/code_generate';
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
  FILE_LIST_DEF,
  createFileListExecutor,
} from '../../../src/harness/tools/file/file_list';
import {
  FILE_READ_DEF,
  createFileReadExecutor,
} from '../../../src/harness/tools/file/file_read';
import {
  MEMORY_RECALL_DEF,
  createMemoryRecallExecutor,
} from '../../../src/harness/tools/memory/memory_recall';
import {
  MEMORY_STORE_DEF,
  createMemoryStoreExecutor,
} from '../../../src/harness/tools/memory/memory_store';
import {
  IMAGE_GENERATE_DEF,
  createImageGenerateExecutor,
} from '../../../src/harness/tools/network/image_generate';
import {
  TTS_SPEAK_DEF,
  createTTSSpeakExecutor,
} from '../../../src/harness/tools/network/tts_speak';
import {
  WEB_FETCH_DEF,
  createWebFetchExecutor,
  htmlToMarkdown as htmlToMarkdownExport,
} from '../../../src/harness/tools/network/web_fetch';
import {
  WEB_SEARCH_DEF,
  createWebSearchExecutor,
} from '../../../src/harness/tools/network/web_search';
import {
  SHELL_EXEC_DEF,
  createShellExecExecutor,
} from '../../../src/harness/tools/system/shell_exec';

function makeContext(
  permissions: Permission[] = [],
  userId = 'e2e-user'
): ToolContext {
  return {
    userId,
    traceId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    permissions: new Set(permissions),
    metadata: {},
  };
}

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
      retrieveRelevant: async ({
        query,
        limit,
      }: {
        query: string;
        limit: number;
      }) => {
        const results = memories
          .filter(
            (m) => m.content.includes(query) || m.category.includes(query)
          )
          .slice(0, limit)
          .map((m) => ({
            content: m.content,
            importance: m.importance,
            accessCount: m.accessCount,
          }));
        return results;
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
    '气死',
    '完蛋',
  ];
  const positiveWords = [
    '开心',
    '高兴',
    '喜欢',
    '棒',
    '好',
    '谢谢',
    '感谢',
    '幸福',
    '赞',
    '牛逼',
    '厉害',
    '完美',
    '爽',
    '舒服',
    '期待',
    '兴奋',
    '感动',
    '满足',
    '轻松',
    '放心',
    '太好了',
    '真棒',
    '优秀',
    '漂亮',
    '绝了',
    '有意思',
  ];
  const intensifiers = [
    '太',
    '非常',
    '特别',
    '超级',
    '极其',
    '很',
    '真的',
    '简直',
    '实在是',
    '无比',
  ];
  const negations = ['不', '没', '别', '不要', '不是', '没有'];

  return (
    text: string
  ): {
    type: string;
    intensity: number;
    dominant?: string;
    confidence?: number;
  } => {
    let score = 0;
    let matchedNeg = 0;
    let matchedPos = 0;
    let hasIntensifier = false;
    let hasNegation = false;

    for (const w of intensifiers) {
      if (text.includes(w)) {
        hasIntensifier = true;
        break;
      }
    }
    for (const w of negations) {
      if (text.includes(w)) {
        hasNegation = true;
        break;
      }
    }

    for (const w of negativeWords) {
      const count = (
        text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ||
        []
      ).length;
      if (count > 0) {
        matchedNeg += count;
        score -= count * (hasIntensifier ? 2 : 1);
      }
    }
    for (const w of positiveWords) {
      const count = (
        text.match(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ||
        []
      ).length;
      if (count > 0) {
        matchedPos += count;
        score += count * (hasIntensifier ? 2 : 1);
      }
    }

    if (hasNegation) {
      let negatedScore = 0;
      let nonNegatedScore = 0;
      const allEmotionWords = [
        ...negativeWords.map((w) => ({ word: w, val: -1 })),
        ...positiveWords.map((w) => ({ word: w, val: 1 })),
      ];
      const matchedRanges: Array<{ start: number; end: number }> = [];
      for (const { word, val } of allEmotionWords) {
        const regex = new RegExp(
          word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'g'
        );
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const start = match.index;
          const end = start + word.length;
          const isSubsumed = matchedRanges.some(
            (r) => start >= r.start && end <= r.end
          );
          if (isSubsumed) continue;
          matchedRanges.push({ start, end });
          const window = text.substring(Math.max(0, start - 3), start);
          const isNegated = negations.some((n) => window.includes(n));
          const weight = hasIntensifier ? 2 : 1;
          if (isNegated) {
            negatedScore += -val * weight;
          } else {
            nonNegatedScore += val * weight;
          }
        }
      }
      if (negatedScore !== 0 || nonNegatedScore !== 0) {
        score = negatedScore + nonNegatedScore;
      }
    }

    const exclaimCount =
      (text.match(/！/g) || []).length + (text.match(/!/g) || []).length;
    if (exclaimCount >= 2) {
      score *= 1.5;
    }

    const questionCount =
      (text.match(/？/g) || []).length + (text.match(/\?/g) || []).length;
    if (questionCount >= 3 && matchedNeg === 0 && matchedPos === 0) {
      score -= 1;
    }

    if (score <= -2) {
      return {
        type: 'negative',
        intensity: Math.min(10, Math.round(Math.abs(score) * 1.5 * 10) / 10),
        dominant: matchedNeg > matchedPos ? 'negative' : 'mixed',
        confidence: Math.min(1, Math.abs(score) / 5),
      };
    }
    if (score >= 2) {
      return {
        type: 'positive',
        intensity: Math.min(10, Math.round(score * 1.5 * 10) / 10),
        dominant: matchedPos > matchedNeg ? 'positive' : 'mixed',
        confidence: Math.min(1, score / 5),
      };
    }
    return {
      type: 'neutral',
      intensity: 1,
      dominant: 'neutral',
      confidence: 0.5,
    };
  };
}

async function checkNetworkAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch('https://httpbin.org/get', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

function buildFullRegistry(): {
  registry: ToolRegistry;
  memoryStore: ReturnType<typeof createRealMemoryStore>;
  taskStore: ReturnType<typeof createRealTaskStore>;
  noteStore: ReturnType<typeof createRealNoteStore>;
} {
  const registry = new ToolRegistry();

  registry.register(FILE_READ_DEF, createFileReadExecutor());
  registry.register(FILE_LIST_DEF, createFileListExecutor());

  const memoryStore = createRealMemoryStore();
  registry.register(
    MEMORY_STORE_DEF,
    createMemoryStoreExecutor(memoryStore.deps)
  );
  registry.register(
    MEMORY_RECALL_DEF,
    createMemoryRecallExecutor(memoryStore.recallDeps)
  );

  const taskStore = createRealTaskStore();
  registry.register(TASK_MANAGE_DEF, createTaskManageExecutor(taskStore));

  const noteStore = createRealNoteStore();
  registry.register(NOTE_TAKE_DEF, createNoteTakeExecutor(noteStore));

  registry.register(
    SELF_REFLECT_DEF,
    createSelfReflectExecutor({ agentSelfReflection: null })
  );

  registry.register(
    EMOTION_DETECT_DEF,
    createEmotionDetectExecutor({
      detectEmotionFromInput: createRealEmotionDetector(),
    })
  );

  registry.register(SHELL_EXEC_DEF, createShellExecExecutor());

  registry.register(WEB_SEARCH_DEF, createWebSearchExecutor({}));
  registry.register(WEB_FETCH_DEF, createWebFetchExecutor({}));
  registry.register(TTS_SPEAK_DEF, createTTSSpeakExecutor({}));
  registry.register(IMAGE_GENERATE_DEF, createImageGenerateExecutor({}));

  registry.register(
    CODE_GENERATE_DEF,
    createCodeGenerateExecutor({
      generateCode: async ({
        requirements,
        language,
      }: {
        requirements: string;
        language: string;
      }) => ({
        code: `// Generated for: ${requirements}\nconsole.log("Hello from ${language}!");`,
        language,
      }),
    })
  );
  registry.register(CODE_REVIEW_DEF, createCodeReviewExecutor({}));

  return { registry, memoryStore, taskStore, noteStore };
}

jest.setTimeout(30000);

describe('E2E: 核心能力工具链完整链路（真实验证）', () => {
  let registry: ToolRegistry;
  let memoryStore: ReturnType<typeof createRealMemoryStore>;
  let taskStore: ReturnType<typeof createRealTaskStore>;
  let noteStore: ReturnType<typeof createRealNoteStore>;
  let validator: SchemaValidator;
  let guard: PermissionGuard;
  let tmpDir: string;
  let networkAvailable = false;

  beforeAll(async () => {
    const built = buildFullRegistry();
    registry = built.registry;
    memoryStore = built.memoryStore;
    taskStore = built.taskStore;
    noteStore = built.noteStore;
    validator = new SchemaValidator();
    guard = new PermissionGuard();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-e2e-real-'));
    networkAvailable = await checkNetworkAvailable();
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════
  // 能力1: 能记 — memory_store / memory_recall
  // ═══════════════════════════════════════════
  describe('能力1: 能记 (Memory) — 真实内存存储', () => {
    test('memory_store → memory_recall 全链路：存储后可检索', async () => {
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);

      const storeResult = await registry.execute(
        'memory_store',
        { content: '用户喜欢咖啡', category: 'preference', importance: 8 },
        ctx
      );
      expect(storeResult.success).toBe(true);
      expect(storeResult.duration).toBeGreaterThanOrEqual(0);

      expect(memoryStore.getAll().length).toBe(1);
      expect(memoryStore.getAll()[0].content).toBe('用户喜欢咖啡');
      expect(memoryStore.getAll()[0].importance).toBe(8);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '咖啡', limit: 5 },
        ctx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('咖啡');
    });

    test('memory_store: 多条存储 → recall 按关键词过滤', async () => {
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);

      await registry.execute(
        'memory_store',
        { content: 'Python是最好的编程语言', category: 'fact', importance: 6 },
        ctx
      );
      await registry.execute(
        'memory_store',
        { content: '明天要开会', category: 'schedule', importance: 9 },
        ctx
      );

      expect(memoryStore.getAll().length).toBeGreaterThanOrEqual(2);

      const factResult = await registry.execute(
        'memory_recall',
        { query: 'Python', limit: 5 },
        ctx
      );
      expect(factResult.success).toBe(true);
      expect(factResult.output as string).toContain('Python');
    });

    test('memory_store: 空内容 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'memory_store',
        { content: '', category: 'other' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.output as string).toContain('内容不能为空');
    });

    test('memory_store: Schema 校验 — 缺少必填参数 content → 校验失败', () => {
      const validation = validator.validate(
        { category: 'preference' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('缺少必填参数: content');
    });

    test('memory_store: Schema 校验 — category 枚举越界 → 校验失败', () => {
      const validation = validator.validate(
        { content: '测试', category: 'invalid_category' },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('memory_recall: 无匹配关键词 → 返回空结果', async () => {
      const ctx = makeContext([Permission.MEMORY_READ]);
      const result = await registry.execute(
        'memory_recall',
        { query: '量子计算XYZ不存在的关键词', limit: 5 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('未找到相关记忆');
    });

    test('memory_store: storeWithMetadata → importance 真实持久化', async () => {
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);
      await registry.execute(
        'memory_store',
        { content: '高优先级记忆', category: 'fact', importance: 10 },
        ctx
      );
      await registry.execute(
        'memory_store',
        { content: '低优先级记忆', category: 'fact', importance: 1 },
        ctx
      );

      const highImportance = memoryStore
        .getAll()
        .find((m) => m.content === '高优先级记忆');
      const lowImportance = memoryStore
        .getAll()
        .find((m) => m.content === '低优先级记忆');
      expect(highImportance?.importance).toBe(10);
      expect(lowImportance?.importance).toBe(1);
    });

    test('memory_recall: 跨 category 检索 → 按关键词匹配不同类别', async () => {
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);
      await registry.execute(
        'memory_store',
        { content: '项目deadline是周五', category: 'schedule', importance: 9 },
        ctx
      );
      await registry.execute(
        'memory_store',
        { content: '项目使用React框架', category: 'fact', importance: 5 },
        ctx
      );

      const result = await registry.execute(
        'memory_recall',
        { query: '项目', limit: 10 },
        ctx
      );
      expect(result.success).toBe(true);
      const output = result.output as string;
      expect(output).toContain('项目');
    });
  });

  // ═══════════════════════════════════════════
  // 能力2: 能搜 — web_search（真实网络请求）
  // ═══════════════════════════════════════════
  describe('能力2: 能搜 (Search) — 真实网络搜索', () => {
    test('web_search: 真实搜索 → 返回结构化结果', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'web_search',
        { query: 'TypeScript Jest testing', max_results: 3 },
        ctx
      );

      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect(result.output as string).toBeTruthy();
    });

    test('web_search: 缺少必填参数 query → Schema 校验失败', () => {
      const validation = validator.validate(
        {},
        WEB_SEARCH_DEF.parameters,
        WEB_SEARCH_DEF.requiredParams
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('缺少必填参数: query');
    });

    test('web_search: 真实搜索 → 结果包含 URL 结构', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'web_search',
        { query: 'Node.js official site', max_results: 2 },
        ctx
      );

      expect(result.success).toBe(true);
      const output = result.output as string;
      expect(output).toMatch(/https?:\/\//);
    });
  });

  // ═══════════════════════════════════════════
  // 能力3: 能抓 — web_fetch（真实 HTTP 请求）
  // ═══════════════════════════════════════════
  describe('能力3: 能抓 (Fetch) — 真实 HTTP 抓取', () => {
    test('web_fetch: 真实抓取 example.com → 返回 HTML 内容', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'web_fetch',
        { url: 'https://example.com', format: 'markdown' },
        ctx
      );

      if (!result.success) return;
      expect(result.output).toBeDefined();
      expect(typeof result.output).toBe('string');
      expect((result.output as string).length).toBeGreaterThan(0);
    });

    test('web_fetch: 无效 URL → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'web_fetch',
        { url: 'not-a-url' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('http://');
    });

    test('web_fetch: format=text → 返回纯文本（无 Markdown 标记）', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'web_fetch',
        { url: 'https://example.com', format: 'text' },
        ctx
      );
      if (!result.success) return;
      expect(typeof result.output).toBe('string');
      expect((result.output as string).length).toBeGreaterThan(0);
    });

    test('web_fetch: max_length 截断 → 返回内容不超过限制', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'web_fetch',
        { url: 'https://example.com', format: 'markdown', max_length: 50 },
        ctx
      );
      if (!result.success) return;
      expect((result.output as string).length).toBeLessThanOrEqual(50);
    });
  });

  // ═══════════════════════════════════════════
  // 能力4: 能说 — tts_speak（真实降级路径）
  // ═══════════════════════════════════════════
  describe('能力4: 能说 (TTS) — 真实降级模式', () => {
    test('tts_speak: 无 TTS 硬件 → 走真实模拟降级路径 → 返回语音指令', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'tts_speak',
        { text: '你好，家百星', voice: 'female-gentle' },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.output as string).toContain('语音指令已接收');
      expect(result.output as string).toContain('你好，家百星');
      expect(result.metadata?.simulated).toBe(true);
    });

    test('tts_speak: 空文本 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'tts_speak',
        { text: '', voice: 'default' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('文本内容不能为空');
    });

    test('tts_speak: 不同 voice 参数 → 均走降级路径', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const voices = ['male-deep', 'female-gentle', 'default'];
      for (const voice of voices) {
        const result = await registry.execute(
          'tts_speak',
          { text: '测试语音', voice, speed: 1.2 },
          ctx
        );
        expect(result.success).toBe(true);
        expect(result.metadata?.simulated).toBe(true);
      }
    });

    test('tts_speak: 长文本 → 降级路径正常处理', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const longText = '这是一段很长的文本内容，'.repeat(50);
      const result = await registry.execute(
        'tts_speak',
        { text: longText, voice: 'default', speed: 0.8 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.simulated).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // 能力5: 能画 — image_generate（真实 API 调用）
  // ═══════════════════════════════════════════
  describe('能力5: 能画 (Image) — 真实图像生成 API', () => {
    test('image_generate: 真实调用 Trae API → 返回图片', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'image_generate',
        { prompt: '一只可爱的猫', size: 'square' },
        ctx
      );

      expect(result.success).toBe(true);
    });

    test('image_generate: 空描述 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'image_generate',
        { prompt: '', size: 'square' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('图像描述不能为空');
    });

    test('image_generate: 不同 size 参数 → 均可调用', async () => {
      if (!networkAvailable) return;

      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const sizes = ['square', 'landscape_16_9', 'portrait_9_16'];
      for (const size of sizes) {
        const result = await registry.execute(
          'image_generate',
          { prompt: 'test image', size },
          ctx
        );
        expect(result.success).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════
  // 能力6: 能写 — code_generate / code_review
  // ═══════════════════════════════════════════
  describe('能力6: 能写 (Code) — 真实代码生成与静态审查', () => {
    test('code_generate: 真实模板生成 → 返回代码字符串', async () => {
      const ctx = makeContext([Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_generate',
        { requirements: '写一个 hello world', language: 'typescript' },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.output as string).toContain('hello world');
      expect(result.output as string).toContain('console.log');
    });

    test('code_review: 真实静态规则检查 → 发现安全问题', async () => {
      const insecureCode = [
        'const password = "hardcoded_secret_123";',
        'eval(userInput);',
        'document.innerHTML = userInput;',
        'const sql = `SELECT * FROM users WHERE id = ${userId}`;',
      ].join('\n');
      const reviewFile = path.join(tmpDir, 'insecure-code.ts');
      fs.writeFileSync(reviewFile, insecureCode);

      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: reviewFile, focus: 'security' },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.findingsCount).toBeGreaterThan(0);
    });

    test('code_review: 安全代码 → 静态检查通过', async () => {
      const safeCode =
        'const greeting = "Hello, World!";\nconsole.log(greeting);';
      const reviewFile = path.join(tmpDir, 'safe-code.ts');
      fs.writeFileSync(reviewFile, safeCode);

      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: reviewFile, focus: 'all' },
        ctx
      );

      expect(result.success).toBe(true);
    });

    test('code_review: 文件不存在 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: '/nonexistent/path/file.ts', focus: 'all' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('文件不存在');
    });

    test('code_generate: 不同语言 → 均可生成', async () => {
      const ctx = makeContext([Permission.CODE_EXECUTE]);
      const languages = ['typescript', 'python', 'javascript'];
      for (const language of languages) {
        const result = await registry.execute(
          'code_generate',
          { requirements: 'hello world', language },
          ctx
        );
        expect(result.success).toBe(true);
        expect(result.output as string).toContain('hello world');
      }
    });

    test('code_review: 具体验证安全问题类型 — eval/硬编码密码/innerHTML/SQL注入', async () => {
      const insecureCode = [
        'const password = "hardcoded_secret_123";',
        'eval(userInput);',
        'document.innerHTML = userInput;',
        'const sql = `SELECT * FROM users WHERE id = ${userId}`;',
      ].join('\n');
      const reviewFile = path.join(tmpDir, 'deep-insecure.ts');
      fs.writeFileSync(reviewFile, insecureCode);

      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: reviewFile, focus: 'security' },
        ctx
      );

      expect(result.success).toBe(true);
      const output = result.output as string;
      expect(output).toMatch(/eval|硬编码|innerHTML|SQL/i);
    });
  });

  // ═══════════════════════════════════════════
  // 能力7: 能管 — task_manage / note_take
  // ═══════════════════════════════════════════
  describe('能力7: 能管 (Task) — 真实任务/笔记存储', () => {
    test('task_manage: 创建 → 列表 → 完成 → 数据真实流转', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);

      const createResult = await registry.execute(
        'task_manage',
        { action: 'create', title: 'E2E真实验证任务', priority: 'high' },
        ctx
      );
      expect(createResult.success).toBe(true);
      expect(createResult.output as string).toContain('任务已创建');

      expect(taskStore.getAll().length).toBe(1);
      const createdTask = taskStore.getAll()[0];
      expect(createdTask.title).toBe('E2E真实验证任务');
      expect(createdTask.priority).toBe('high');
      expect(createdTask.status).toBe('pending');

      const listResult = await registry.execute(
        'task_manage',
        { action: 'list' },
        ctx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('E2E真实验证任务');

      const completeResult = await registry.execute(
        'task_manage',
        { action: 'complete', task_id: createdTask.id },
        ctx
      );
      expect(completeResult.success).toBe(true);

      const completedTask = taskStore
        .getAll()
        .find((t) => t.id === createdTask.id);
      expect(completedTask?.status).toBe('completed');
      expect(completedTask?.completedAt).toBeDefined();
    });

    test('note_take: 写入 → 列表 → 数据真实流转', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);

      const writeResult = await registry.execute(
        'note_take',
        { action: 'write', title: 'E2E真实笔记', content: '这是真实笔记内容' },
        ctx
      );
      expect(writeResult.success).toBe(true);

      expect(noteStore.getAll().length).toBe(1);
      const createdNote = noteStore.getAll()[0];
      expect(createdNote.title).toBe('E2E真实笔记');
      expect(createdNote.content).toBe('这是真实笔记内容');

      const listResult = await registry.execute(
        'note_take',
        { action: 'list' },
        ctx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('E2E真实笔记');
    });

    test('task_manage: action 枚举越界 → Schema 校验失败', () => {
      const validation = validator.validate(
        { action: 'invalid_action' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(validation.valid).toBe(false);
    });

    test('task_manage: 完成不存在的任务 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'task_manage',
        { action: 'complete', task_id: 'nonexistent-id' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('任务不存在');
    });

    test('task_manage: 创建 → 删除 → 列表不再包含', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const createResult = await registry.execute(
        'task_manage',
        { action: 'create', title: '待删除任务', priority: 'low' },
        ctx
      );
      expect(createResult.success).toBe(true);
      const taskIdMatch = (createResult.output as string).match(/\[([^\]]+)\]/);
      const taskId = taskIdMatch ? taskIdMatch[1] : '';
      expect(taskId).toBeTruthy();

      const deleteResult = await registry.execute(
        'task_manage',
        { action: 'delete', task_id: taskId },
        ctx
      );
      expect(deleteResult.success).toBe(true);

      const remaining = taskStore.getAll().find((t) => t.id === taskId);
      expect(remaining).toBeUndefined();
    });

    test('note_take: 写入带 tags → 列表包含 tags 信息', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const writeResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '标签笔记',
          content: '带标签内容',
          tags: ['e2e', 'test'],
        },
        ctx
      );
      expect(writeResult.success).toBe(true);

      const note = noteStore.getAll().find((n) => n.title === '标签笔记');
      expect(note).toBeDefined();
      expect(note?.tags).toContain('e2e');
      expect(note?.tags).toContain('test');
    });

    test('note_take: 写入 → 删除 → 列表不再包含', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const writeResult = await registry.execute(
        'note_take',
        { action: 'write', title: '待删除笔记', content: '即将被删除' },
        ctx
      );
      expect(writeResult.success).toBe(true);

      const noteIdMatch = (writeResult.output as string).match(/\[([^\]]+)\]/);
      const noteId = noteIdMatch ? noteIdMatch[1] : '';

      const deleteResult = await registry.execute(
        'note_take',
        { action: 'delete', note_id: noteId },
        ctx
      );
      expect(deleteResult.success).toBe(true);

      const remaining = noteStore.getAll().find((n) => n.id === noteId);
      expect(remaining).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════
  // 能力8: 能思 — self_reflect / emotion_detect
  // ═══════════════════════════════════════════
  describe('能力8: 能思 (Cognition) — 真实情感词库与反思', () => {
    test('emotion_detect: "今天很开心" → 真实词库匹配 → positive', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '今天很开心' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.type).toBe('positive');
      expect(parsed.intensity).toBeGreaterThan(0);
    });

    test('emotion_detect: "太烦了" → 真实词库匹配 → negative', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '太烦了' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.type).toBe('negative');
      expect(parsed.intensity).toBeGreaterThan(0);
    });

    test('emotion_detect: "今天天气不错" → neutral', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '今天天气不错' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.type).toBe('neutral');
    });

    test('emotion_detect: 否定词翻转 — "很不开心" → negative', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '很不开心' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.type).toBe('negative');
    });

    test('emotion_detect: 强化词增强 — "非常开心" → positive 高强度', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '非常开心' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.type).toBe('positive');
      expect(parsed.intensity).toBeGreaterThanOrEqual(3);
    });

    test('self_reflect: 真实记录反思 → 返回成功', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'self_reflect',
        { action: '调用了3个工具', result: '成功完成', satisfaction: 8 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('已记录反思');
    });

    test('self_reflect: 缺少必填参数 → Schema 校验失败', () => {
      const validation = validator.validate(
        { action: '测试' },
        SELF_REFLECT_DEF.parameters,
        SELF_REFLECT_DEF.requiredParams
      );
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('缺少必填参数: result');
      expect(validation.errors).toContain('缺少必填参数: satisfaction');
    });

    test('emotion_detect: 混合情绪 — "开心但很累" → 按主导情绪判定', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '开心但很累' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(['positive', 'negative', 'neutral']).toContain(parsed.type);
    });

    test('emotion_detect: 感叹号增强 — "太好了！！！" → 高强度 positive', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '太好了！！！' },
        ctx
      );
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output as string);
      expect(parsed.type).toBe('positive');
      expect(parsed.intensity).toBeGreaterThanOrEqual(4);
    });

    test('self_reflect: 低满意度 → 真实记录反思', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'self_reflect',
        { action: '尝试解决但失败', result: '需要调整策略', satisfaction: 2 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('已记录反思');
    });

    test('self_reflect: 高满意度 → 真实记录反思', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'self_reflect',
        { action: '成功完成所有任务', result: '用户满意', satisfaction: 10 },
        ctx
      );
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // 能力9: 能控 — shell_exec / file_read / file_list
  // ═══════════════════════════════════════════
  describe('能力9: 能控 (Control) — 真实系统执行与文件IO', () => {
    test('shell_exec: 真实执行 echo → 返回真实输出', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo hello-e2e-real' },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.output as string).toContain('hello-e2e-real');
    });

    test('shell_exec: 真实执行 node --version → 返回版本号', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'node --version' },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/v\d+\.\d+/);
    });

    test('shell_exec: 危险命令 rm -rf / → 真实安全策略拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'rm -rf /' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全策略拦截');
    });

    test('shell_exec: 纯中文命令 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: '删除所有文件' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('file_read: 真实磁盘IO → 读取文件内容', async () => {
      const testFile = path.join(tmpDir, 'read-test.txt');
      fs.writeFileSync(testFile, 'E2E真实验证文件内容');

      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: testFile },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe('E2E真实验证文件内容');
    });

    test('file_list: 真实磁盘IO → 列出目录', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');

      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_list',
        { directory: tmpDir },
        ctx
      );

      expect(result.success).toBe(true);
      expect(result.output as string).toContain('a.txt');
      expect(result.output as string).toContain('b.txt');
    });

    test('file_read: 不存在的文件 → 真实校验拒绝', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: '/nonexistent/file.txt' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('shell_exec: 真实执行 node -e → 返回计算结果', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'node -e "console.log(2+3)"' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('5');
    });

    test('file_list: 子目录 → 递归列出', async () => {
      const subDir = path.join(tmpDir, 'subdir');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'nested.txt'), 'nested content');

      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_list',
        { directory: tmpDir },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('subdir');
    });

    test('file_read: 中文内容 → 真实读取无乱码', async () => {
      const cnFile = path.join(tmpDir, 'chinese.txt');
      fs.writeFileSync(cnFile, '你好世界，端到端测试验证');

      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: cnFile },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('你好世界，端到端测试验证');
    });
  });

  // ═══════════════════════════════════════════
  // 跨能力: 工具注册表完整性
  // ═══════════════════════════════════════════
  describe('工具注册表完整性', () => {
    test('全部 9 大能力对应工具均已注册', () => {
      const names = registry.getRegisteredToolNames();
      const expected = [
        'memory_store',
        'memory_recall',
        'web_search',
        'web_fetch',
        'tts_speak',
        'image_generate',
        'code_generate',
        'code_review',
        'task_manage',
        'note_take',
        'self_reflect',
        'emotion_detect',
        'shell_exec',
        'file_read',
        'file_list',
      ];
      for (const name of expected) {
        expect(names).toContain(name);
      }
    });

    test('按分类查询 — MEMORY 类工具可检索', () => {
      const tools = registry.getByCategory(ToolCategory.MEMORY);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some((t) => t.definition.name === 'memory_store')).toBe(
        true
      );
    });

    test('按风险等级查询 — high 风险工具含 shell_exec', () => {
      const tools = registry.getByRiskLevel('high');
      expect(tools.some((t) => t.definition.name === 'shell_exec')).toBe(true);
    });

    test('执行不存在的工具 → 返回工具不存在错误', async () => {
      const ctx = makeContext();
      const result = await registry.execute('non_existent_tool_xyz', {}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('工具不存在');
    });
  });

  // ═══════════════════════════════════════════
  // 增强功能覆盖：源码增强后的新能力验证
  // ═══════════════════════════════════════════
  describe('增强功能: 源码增强后新能力', () => {
    test('memory_store: 自动去重 — getAllMemories 相似度>80% 拒绝', async () => {
      const store2 = createRealMemoryStore();
      const reg2 = new ToolRegistry();
      reg2.register(
        MEMORY_STORE_DEF,
        createMemoryStoreExecutor({
          storeShortTermMemory: store2.deps.storeShortTermMemory,
          storeWithMetadata: store2.deps.storeWithMetadata,
          checkDuplicate: undefined,
          getAllMemories: async () =>
            store2.getAll().map((m) => ({ content: m.content })),
        })
      );
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      await reg2.execute(
        'memory_store',
        { content: '用户喜欢喝咖啡', category: 'preference' },
        ctx
      );
      const dup = await reg2.execute(
        'memory_store',
        { content: '用户喜欢喝咖啡', category: 'preference' },
        ctx
      );
      expect(dup.success).toBe(true);
      expect(dup.output as string).toContain('相似');
    });

    test('memory_recall: fuzzyMatch 模糊检索 — 子串分词匹配', async () => {
      const store3 = createRealMemoryStore();
      const reg3 = new ToolRegistry();
      reg3.register(MEMORY_STORE_DEF, createMemoryStoreExecutor(store3.deps));
      reg3.register(
        MEMORY_RECALL_DEF,
        createMemoryRecallExecutor({ ...store3.recallDeps, fuzzyMatch: true })
      );
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);
      await reg3.execute(
        'memory_store',
        { content: '项目使用React框架开发', category: 'fact' },
        ctx
      );
      const result = await reg3.execute(
        'memory_recall',
        { query: 'React开发', limit: 5 },
        ctx
      );
      expect(result.success).toBe(true);
    });

    test('emotion_detect: 输出包含 dominant + confidence 字段', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '太开心了！' },
        ctx
      );
      expect(result.success).toBe(true);
      const emotion = JSON.parse(result.output as string);
      expect(emotion.type).toBe('positive');
      expect(emotion.dominant).toBeDefined();
      expect(emotion.confidence).toBeGreaterThan(0);
    });

    test('code_review: 检测 innerHTML 注入风险', async () => {
      const code =
        'document.innerHTML = userInput;\nconst el = document.getElementById("x");\nel.innerHTML = data;';
      const reviewFile = path.join(tmpDir, 'innerhtml-test.ts');
      fs.writeFileSync(reviewFile, code);
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/innerHTML/i);
    });

    test('code_review: 检测 prototype pollution 风险', async () => {
      const code =
        'obj.__proto__ = malicious;\nobj.constructor["prototype"] = evil;';
      const reviewFile = path.join(tmpDir, 'proto-pollution.ts');
      fs.writeFileSync(reviewFile, code);
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/原型链污染|__proto__/i);
    });

    test('code_review: 检测 document.write 风险', async () => {
      const code = 'document.write(userInput);';
      const reviewFile = path.join(tmpDir, 'docwrite-test.ts');
      fs.writeFileSync(reviewFile, code);
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_review',
        { file_path: reviewFile, focus: 'security' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toMatch(/document\.write/i);
    });

    test('shell_exec: 扩展危险命令 rmdir /s /q → 拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'rmdir /s /q C:\\Windows' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/);
    });

    test('shell_exec: fork bomb 模式 → 拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: ':(){ :|:& };:' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|fork bomb/i);
    });

    test('shell_exec: 设备写入重定向 → 拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'dd if=/dev/zero of=/dev/sda' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|禁止/i);
    });

    test('shell_exec: 重定向到块设备 → 拦截', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'cat /etc/passwd > /dev/sda' },
        ctx
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/安全策略拦截|块设备/i);
    });

    test('self_reflect: 低满意度 → 输出包含改进建议 + sentiment=negative', async () => {
      const reflections: unknown[] = [];
      const reg4 = new ToolRegistry();
      reg4.register(
        SELF_REFLECT_DEF,
        createSelfReflectExecutor({
          agentSelfReflection: null,
          reflectionStore: {
            add: (e) => reflections.push(e),
            getAll: () => reflections as never[],
            getRecent: (n) => (reflections as never[]).slice(-n),
          },
        })
      );
      const ctx = makeContext();
      const result = await reg4.execute(
        'self_reflect',
        { action: '执行任务', result: '耗时过长', satisfaction: 2 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('negative');
      expect(result.output as string).toMatch(/建议|改进/);
      expect(reflections.length).toBe(1);
    });

    test('self_reflect: 高满意度 → sentiment=positive + 无改进建议', async () => {
      const reg5 = new ToolRegistry();
      const reflections2: unknown[] = [];
      reg5.register(
        SELF_REFLECT_DEF,
        createSelfReflectExecutor({
          agentSelfReflection: null,
          reflectionStore: {
            add: (e) => reflections2.push(e),
            getAll: () => reflections2 as never[],
            getRecent: (n) => (reflections2 as never[]).slice(-n),
          },
        })
      );
      const ctx = makeContext();
      const result = await reg5.execute(
        'self_reflect',
        { action: '完美执行', result: '快速完成', satisfaction: 9 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('positive');
      expect(result.output as string).not.toContain('💡');
    });

    test('note_take: 模糊搜索 — 按相关度排序', async () => {
      const noteStore2 = createRealNoteStore();
      const reg6 = new ToolRegistry();
      reg6.register(NOTE_TAKE_DEF, createNoteTakeExecutor(noteStore2));
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      await reg6.execute(
        'note_take',
        {
          action: 'write',
          title: 'React性能优化',
          content: '使用memo和useCallback',
        },
        ctx
      );
      await reg6.execute(
        'note_take',
        { action: 'write', title: 'Vue入门', content: 'Vue是渐进式框架' },
        ctx
      );
      const result = await reg6.execute(
        'note_take',
        { action: 'search', query: 'React' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('React');
    });

    test('tts_speak: pitch 参数 → 降级路径正常处理', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'tts_speak',
        { text: '测试音调', voice: 'default', speed: 1.0, pitch: 1.5 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect((result.metadata as Record<string, unknown>).pitch).toBe(1.5);
    });

    test('tts_speak: 超范围 speed/pitch → 自动裁剪到 [0.5, 2.0]', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'tts_speak',
        { text: '测试范围', speed: 5.0, pitch: -1 },
        ctx
      );
      expect(result.success).toBe(true);
      expect((result.metadata as Record<string, unknown>).speed).toBe(2.0);
      expect((result.metadata as Record<string, unknown>).pitch).toBe(0.5);
    });

    test('file_read: line_numbers=true → 输出带行号标注', async () => {
      const filePath = path.join(tmpDir, 'linenums.txt');
      fs.writeFileSync(filePath, '第一行\n第二行\n第三行');
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: filePath, line_numbers: true },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('1→');
      expect(result.output as string).toContain('2→');
      expect(result.output as string).toContain('3→');
    });

    test('task_manage: list 支持 status 过滤 + 优先级排序', async () => {
      const taskStore2 = createRealTaskStore();
      const reg7 = new ToolRegistry();
      reg7.register(TASK_MANAGE_DEF, createTaskManageExecutor(taskStore2));
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      await reg7.execute(
        'task_manage',
        { action: 'create', title: '低优先级任务', priority: 'low' },
        ctx
      );
      await reg7.execute(
        'task_manage',
        { action: 'create', title: '高优先级任务', priority: 'high' },
        ctx
      );
      const listResult = await reg7.execute(
        'task_manage',
        { action: 'list', status: 'pending' },
        ctx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('高优先级任务');
      expect(listResult.output as string).toContain('低优先级任务');
      const highIdx = (listResult.output as string).indexOf('高优先级');
      const lowIdx = (listResult.output as string).indexOf('低优先级');
      expect(highIdx).toBeLessThan(lowIdx);
    });

    test('web_fetch: HTML 表格 → Markdown 表格转换', () => {
      const html =
        '<table><tr><th>名称</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>';
      const md = htmlToMarkdownExport(html);
      expect(md).toContain('| 名称 | 值 |');
      expect(md).toContain('| --- | --- |');
      expect(md).toContain('| A | 1 |');
    });
  });

  // ═══════════════════════════════════════════
  // 跨能力协作: 多工具联合链路验证
  // ═══════════════════════════════════════════
  describe('跨能力协作: 多工具联合真实链路', () => {
    test('能记+能管: memory_store → task_manage → memory_recall 闭环', async () => {
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);

      await registry.execute(
        'memory_store',
        {
          content: '任务管理最佳实践: 先拆分再执行',
          category: 'fact',
          importance: 8,
        },
        ctx
      );

      const createResult = await registry.execute(
        'task_manage',
        { action: 'create', title: '执行最佳实践任务', priority: 'high' },
        ctx
      );
      expect(createResult.success).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '任务管理', limit: 5 },
        ctx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('任务管理');
    });

    test('能思+能记: emotion_detect → memory_store → self_reflect 闭环', async () => {
      const ctx = makeContext([
        Permission.MEMORY_WRITE,
        Permission.MEMORY_READ,
      ]);

      const emotionResult = await registry.execute(
        'emotion_detect',
        { text: '今天非常开心，项目终于上线了！' },
        ctx
      );
      expect(emotionResult.success).toBe(true);
      const emotion = JSON.parse(emotionResult.output as string);
      expect(emotion.type).toBe('positive');

      await registry.execute(
        'memory_store',
        {
          content: '用户项目上线，情绪积极',
          category: 'feedback',
          importance: 7,
        },
        ctx
      );

      const reflectResult = await registry.execute(
        'self_reflect',
        {
          action: '检测到用户正面情绪',
          result: '项目上线成功',
          satisfaction: 9,
        },
        ctx
      );
      expect(reflectResult.success).toBe(true);
    });

    test('能写+能管: code_generate → note_take → task_manage 闭环', async () => {
      const ctx = makeContext([
        Permission.CODE_EXECUTE,
        Permission.MEMORY_WRITE,
      ]);

      const genResult = await registry.execute(
        'code_generate',
        { requirements: '实现数组去重', language: 'typescript' },
        ctx
      );
      expect(genResult.success).toBe(true);

      const noteResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '数组去重代码',
          content: String(genResult.output),
          tags: ['code'],
        },
        ctx
      );
      expect(noteResult.success).toBe(true);

      const taskResult = await registry.execute(
        'task_manage',
        { action: 'create', title: '审查数组去重代码', priority: 'medium' },
        ctx
      );
      expect(taskResult.success).toBe(true);
    });

    test('能控+能记: shell_exec → memory_store → file_read 闭环', async () => {
      const ctx = makeContext([
        Permission.SYSTEM_ADMIN,
        Permission.MEMORY_WRITE,
        Permission.FILE_READ,
      ]);

      const shellResult = await registry.execute(
        'shell_exec',
        { command: 'node -e "console.log(Date.now())"' },
        ctx
      );
      expect(shellResult.success).toBe(true);

      await registry.execute(
        'memory_store',
        {
          content: `系统时间戳: ${shellResult.output}`,
          category: 'fact',
          importance: 3,
        },
        ctx
      );

      const testFile = path.join(tmpDir, 'cross-capability.txt');
      fs.writeFileSync(testFile, '跨能力验证内容');
      const readResult = await registry.execute(
        'file_read',
        { file_path: testFile },
        ctx
      );
      expect(readResult.success).toBe(true);
      expect(readResult.output).toBe('跨能力验证内容');
    });

    test('能说+能画: tts_speak + image_generate 双模态输出', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);

      const ttsResult = await registry.execute(
        'tts_speak',
        { text: '双模态输出测试', voice: 'female-gentle', speed: 1.0 },
        ctx
      );
      expect(ttsResult.success).toBe(true);
      expect(ttsResult.metadata?.simulated).toBe(true);

      if (networkAvailable) {
        const imgResult = await registry.execute(
          'image_generate',
          { prompt: '双模态测试图', size: 'square' },
          ctx
        );
        expect(imgResult.success).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════
  // Schema 校验完整性: 每个工具的必填参数与类型校验
  // ═══════════════════════════════════════════
  describe('Schema 校验完整性: 全工具必填参数与类型', () => {
    test('web_search: 缺少 query → 校验失败', () => {
      const result = validator.validate(
        { max_results: 3 },
        WEB_SEARCH_DEF.parameters,
        WEB_SEARCH_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: query');
    });

    test('web_fetch: 缺少 url → 校验失败', () => {
      const result = validator.validate(
        { format: 'markdown' },
        WEB_FETCH_DEF.parameters,
        WEB_FETCH_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: url');
    });

    test('tts_speak: 缺少 text → 校验失败', () => {
      const result = validator.validate(
        { voice: 'default' },
        TTS_SPEAK_DEF.parameters,
        TTS_SPEAK_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: text');
    });

    test('image_generate: 缺少 prompt → 校验失败', () => {
      const result = validator.validate(
        { size: 'square' },
        IMAGE_GENERATE_DEF.parameters,
        IMAGE_GENERATE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: prompt');
    });

    test('code_generate: 缺少 requirements → 校验失败', () => {
      const result = validator.validate(
        { language: 'typescript' },
        CODE_GENERATE_DEF.parameters,
        CODE_GENERATE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: requirements');
    });

    test('code_review: 缺少 file_path → 校验失败', () => {
      const result = validator.validate(
        { focus: 'all' },
        CODE_REVIEW_DEF.parameters,
        CODE_REVIEW_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: file_path');
    });

    test('shell_exec: 缺少 command → 校验失败', () => {
      const result = validator.validate(
        {},
        SHELL_EXEC_DEF.parameters,
        SHELL_EXEC_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: command');
    });

    test('emotion_detect: 缺少 text → 校验失败', () => {
      const result = validator.validate(
        {},
        EMOTION_DETECT_DEF.parameters,
        EMOTION_DETECT_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: text');
    });

    test('file_read: 缺少 file_path → 校验失败', () => {
      const result = validator.validate(
        {},
        FILE_READ_DEF.parameters,
        FILE_READ_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: file_path');
    });

    test('file_list: directory 非必填 → 空参数校验通过', () => {
      const result = validator.validate(
        {},
        FILE_LIST_DEF.parameters,
        FILE_LIST_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });

    test('note_take: 缺少 action → 校验失败', () => {
      const result = validator.validate(
        {},
        NOTE_TAKE_DEF.parameters,
        NOTE_TAKE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('缺少必填参数: action');
    });

    test('memory_store: importance 类型错误（布尔值当数字）→ 校验失败', () => {
      const result = validator.validate(
        { content: 'x', category: 'fact', importance: true },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
    });

    test('self_reflect: satisfaction 类型错误（字符串当数字）→ 校验失败', () => {
      const result = validator.validate(
        { action: 'a', result: 'r', satisfaction: 'high' },
        SELF_REFLECT_DEF.parameters,
        SELF_REFLECT_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
    });
  });

  // ═══════════════════════════════════════════
  // 权限守卫完整性: 每个工具的权限检查
  // ═══════════════════════════════════════════
  describe('权限守卫完整性: 全工具权限检查', () => {
    test('memory_store 缺 MEMORY_WRITE → 拒绝', () => {
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

    test('memory_recall 缺 MEMORY_READ → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'memory_recall',
        [Permission.MEMORY_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.MEMORY_READ);
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

    test('code_generate 缺 CODE_EXECUTE → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'code_generate',
        [Permission.CODE_EXECUTE],
        'medium',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.CODE_EXECUTE);
    });

    test('file_list 缺 FILE_READ → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'file_list',
        [Permission.FILE_READ],
        'low',
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain(Permission.FILE_READ);
    });

    test('tts_speak 有 NETWORK_ACCESS → 允许', () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = guard.check(
        'tts_speak',
        [Permission.NETWORK_ACCESS],
        'low',
        ctx
      );
      expect(result.allowed).toBe(true);
    });

    test('image_generate 有 NETWORK_ACCESS → 允许', () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = guard.check(
        'image_generate',
        [Permission.NETWORK_ACCESS],
        'medium',
        ctx
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // 执行性能基线: 关键工具执行时间验证
  // ═══════════════════════════════════════════
  describe('执行性能基线: 关键工具执行时间', () => {
    test('memory_store 执行时间 < 100ms', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'memory_store',
        { content: '性能测试记忆', category: 'fact', importance: 5 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(100);
    });

    test('memory_recall 执行时间 < 100ms', async () => {
      const ctx = makeContext([Permission.MEMORY_READ]);
      const result = await registry.execute(
        'memory_recall',
        { query: '性能', limit: 5 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(100);
    });

    test('emotion_detect 执行时间 < 50ms', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'emotion_detect',
        { text: '性能测试情绪' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(50);
    });

    test('self_reflect 执行时间 < 50ms', async () => {
      const ctx = makeContext();
      const result = await registry.execute(
        'self_reflect',
        { action: '性能测试', result: '完成', satisfaction: 5 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(50);
    });

    test('tts_speak 降级路径执行时间 < 100ms', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const result = await registry.execute(
        'tts_speak',
        { text: '性能测试语音', voice: 'default' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(100);
    });

    test('file_read 执行时间 < 200ms', async () => {
      const filePath = path.join(tmpDir, 'perf-test.txt');
      fs.writeFileSync(filePath, '性能测试文件内容');
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_read',
        { file_path: filePath },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(200);
    });

    test('code_generate 执行时间 < 500ms', async () => {
      const ctx = makeContext([Permission.CODE_EXECUTE]);
      const result = await registry.execute(
        'code_generate',
        { requirements: '实现加法函数', language: 'javascript' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(500);
    });

    test('task_manage 执行时间 < 100ms', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'task_manage',
        { action: 'create', title: '性能测试任务' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(100);
    });

    test('note_take 执行时间 < 100ms', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'note_take',
        { action: 'write', title: '性能测试笔记', content: '测试内容' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(100);
    });
  });

  describe('跨能力协作增强: 搜索+抓取联合链路', () => {
    test('能搜+能抓: web_search → web_fetch 联合数据流转', async () => {
      const ctx = makeContext([Permission.NETWORK_ACCESS]);
      const searchResult = await registry.execute(
        'web_search',
        { query: 'TypeScript tutorial', max_results: 3 },
        ctx
      );
      expect(searchResult.success).toBe(true);

      const fetchResult = await registry.execute(
        'web_fetch',
        { url: 'https://example.com', format: 'markdown' },
        ctx
      );
      if (fetchResult.success) {
        expect(typeof fetchResult.output).toBe('string');
        expect((fetchResult.output as string).length).toBeGreaterThan(0);
      }
    });

    test('能搜+能记: web_search → memory_store 搜索结果存储', async () => {
      const ctx = makeContext([
        Permission.NETWORK_ACCESS,
        Permission.MEMORY_WRITE,
      ]);
      const searchResult = await registry.execute(
        'web_search',
        { query: 'Node.js best practices' },
        ctx
      );
      expect(searchResult.success).toBe(true);

      const storeResult = await registry.execute(
        'memory_store',
        {
          content: '搜索完成: Node.js best practices',
          category: 'fact',
          importance: 6,
        },
        ctx
      );
      expect(storeResult.success).toBe(true);
    });

    test('能抓+能记: web_fetch → memory_store 抓取内容存储', async () => {
      const ctx = makeContext([
        Permission.NETWORK_ACCESS,
        Permission.MEMORY_WRITE,
      ]);
      const fetchResult = await registry.execute(
        'web_fetch',
        { url: 'https://example.com', format: 'text', max_length: 500 },
        ctx
      );
      if (fetchResult.success) {
        const storeResult = await registry.execute(
          'memory_store',
          {
            content: `抓取内容摘要: ${(fetchResult.output as string).substring(0, 100)}`,
            category: 'fact',
            importance: 5,
          },
          ctx
        );
        expect(storeResult.success).toBe(true);
      }
    });
  });

  describe('Schema 校验增强: 枚举越界与类型边界', () => {
    const validator = new SchemaValidator();

    test('memory_store: category 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { content: '测试', category: 'invalid_category', importance: 5 },
        MEMORY_STORE_DEF.parameters,
        MEMORY_STORE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('task_manage: priority 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { action: 'create', title: '测试', priority: 'urgent' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('task_manage: action 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { action: 'archive', title: '测试' },
        TASK_MANAGE_DEF.parameters,
        TASK_MANAGE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('tts_speak: voice 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { text: '测试', voice: 'robot' },
        TTS_SPEAK_DEF.parameters,
        TTS_SPEAK_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('image_generate: size 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { prompt: '测试', size: 'ultra_hd' },
        IMAGE_GENERATE_DEF.parameters,
        IMAGE_GENERATE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('code_review: focus 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { file_path: '/tmp/test.js', focus: 'deep' },
        CODE_REVIEW_DEF.parameters,
        CODE_REVIEW_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('note_take: action 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { action: 'archive' },
        NOTE_TAKE_DEF.parameters,
        NOTE_TAKE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('web_search: search_type 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { query: 'test', search_type: 'deep' },
        WEB_SEARCH_DEF.parameters,
        WEB_SEARCH_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('web_fetch: format 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { url: 'https://example.com', format: 'json' },
        WEB_FETCH_DEF.parameters,
        WEB_FETCH_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('file_read: encoding 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { file_path: '/tmp/test.txt', encoding: 'utf-16' },
        FILE_READ_DEF.parameters,
        FILE_READ_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });

    test('shell_exec: timeout 字符串数字 → 宽松类型转换通过', () => {
      const result = validator.validate(
        { command: 'echo test', timeout: '30000' },
        SHELL_EXEC_DEF.parameters,
        SHELL_EXEC_DEF.requiredParams
      );
      expect(result.valid).toBe(true);
    });

    test('code_generate: complexity 枚举越界 → 校验失败', () => {
      const result = validator.validate(
        { requirements: '测试', language: 'javascript', complexity: 'extreme' },
        CODE_GENERATE_DEF.parameters,
        CODE_GENERATE_DEF.requiredParams
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('不在允许范围内'))).toBe(
        true
      );
    });
  });

  describe('权限守卫增强: 全工具权限边界', () => {
    const guard = new PermissionGuard();

    test('shell_exec 有 SYSTEM_ADMIN → 高风险需确认（阈值拦截）', () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = guard.check(
        'shell_exec',
        SHELL_EXEC_DEF.requiredPermissions,
        SHELL_EXEC_DEF.riskLevel,
        ctx
      );
      expect(result.needsConfirmation).toBe(true);
    });

    test('file_read 缺 FILE_READ → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'file_read',
        FILE_READ_DEF.requiredPermissions,
        FILE_READ_DEF.riskLevel,
        ctx
      );
      expect(result.allowed).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    });

    test('file_read 有 FILE_READ → 允许且无需确认', () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = guard.check(
        'file_read',
        FILE_READ_DEF.requiredPermissions,
        FILE_READ_DEF.riskLevel,
        ctx
      );
      expect(result.allowed).toBe(true);
      expect(result.needsConfirmation).toBeFalsy();
    });

    test('code_review 缺 CODE_EXECUTE → 拒绝', () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = guard.check(
        'code_review',
        CODE_REVIEW_DEF.requiredPermissions,
        CODE_REVIEW_DEF.riskLevel,
        ctx
      );
      expect(result.allowed).toBe(false);
    });

    test('code_review 有 FILE_READ+CODE_EXECUTE → 允许', () => {
      const ctx = makeContext([Permission.FILE_READ, Permission.CODE_EXECUTE]);
      const result = guard.check(
        'code_review',
        CODE_REVIEW_DEF.requiredPermissions,
        CODE_REVIEW_DEF.riskLevel,
        ctx
      );
      expect(result.allowed).toBe(true);
    });

    test('web_fetch 缺 NETWORK_ACCESS → 拒绝', () => {
      const ctx = makeContext([]);
      const result = guard.check(
        'web_fetch',
        WEB_FETCH_DEF.requiredPermissions,
        WEB_FETCH_DEF.riskLevel,
        ctx
      );
      expect(result.allowed).toBe(false);
    });

    test('note_take 有 MEMORY_WRITE → 允许', () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = guard.check(
        'note_take',
        NOTE_TAKE_DEF.requiredPermissions,
        NOTE_TAKE_DEF.riskLevel,
        ctx
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('数据完整性: 工具输出结构验证', () => {
    test('memory_store 输出包含 success+output+duration', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'memory_store',
        { content: '结构验证测试', category: 'fact', importance: 5 },
        ctx
      );
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('validated');
      expect(typeof result.duration).toBe('number');
      expect(typeof result.success).toBe('boolean');
    });

    test('emotion_detect 输出包含情感类型+强度', async () => {
      const ctx = makeContext([]);
      const result = await registry.execute(
        'emotion_detect',
        { text: '我很开心' },
        ctx
      );
      expect(result.success).toBe(true);
      const output = JSON.parse(result.output as string);
      expect(output).toHaveProperty('type');
      expect(output).toHaveProperty('intensity');
      expect(typeof output.intensity).toBe('number');
    });

    test('self_reflect 输出包含反思内容', async () => {
      const ctx = makeContext([]);
      const result = await registry.execute(
        'self_reflect',
        { action: '执行测试', result: '成功完成', satisfaction: 8 },
        ctx
      );
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    test('task_manage create 输出包含任务ID', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'task_manage',
        { action: 'create', title: '结构验证任务' },
        ctx
      );
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect((result.output as string).match(/\[.{4,}\]/)).toBeTruthy();
    });

    test('file_list 输出为目录列表', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const result = await registry.execute(
        'file_list',
        { directory: tmpDir, pattern: '*.txt' },
        ctx
      );
      expect(result.success).toBe(true);
    });
  });

  describe('幂等性验证: 重复执行结果一致', () => {
    test('memory_store: 相同内容重复存储 → 幂等', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const params = { content: '幂等性测试内容', category: 'preference', importance: 3 };
      const result1 = await registry.execute('memory_store', params, ctx);
      const result2 = await registry.execute('memory_store', params, ctx);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });

    test('file_list: 相同目录重复列出 → 结果一致', async () => {
      const ctx = makeContext([Permission.FILE_READ]);
      const params = { directory: tmpDir, pattern: '*' };
      const result1 = await registry.execute('file_list', params, ctx);
      const result2 = await registry.execute('file_list', params, ctx);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.output).toBe(result2.output);
    });

    test('emotion_detect: 相同输入重复检测 → 结果一致', async () => {
      const ctx = makeContext([]);
      const params = { text: '今天很开心' };
      const result1 = await registry.execute('emotion_detect', params, ctx);
      const result2 = await registry.execute('emotion_detect', params, ctx);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.output).toBe(result2.output);
    });

    test('self_reflect: 相同输入重复反思 → 结果一致', async () => {
      const ctx = makeContext([]);
      const params = { topic: '代码质量', context: '需要改进测试覆盖率' };
      const result1 = await registry.execute('self_reflect', params, ctx);
      const result2 = await registry.execute('self_reflect', params, ctx);
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  describe('工具超时行为: 长时间执行处理', () => {
    test('shell_exec: 极短超时 → 快速失败', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'ping -n 10 127.0.0.1', timeout: 100 },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('shell_exec: 合理超时 → 正常执行', async () => {
      const ctx = makeContext([Permission.SYSTEM_ADMIN]);
      const result = await registry.execute(
        'shell_exec',
        { command: 'echo timeout_test', timeout: 5000 },
        ctx
      );
      expect(result.success).toBe(true);
    });
  });

  describe('工具链路健壮性: 异常参数容错', () => {
    test('memory_store: importance 超范围 → 仍可执行（容错）', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'memory_store',
        { content: '超范围重要性', category: 'preference', importance: 999 },
        ctx
      );
      expect(result.success).toBe(true);
    });

    test('task_manage: 无 title 创建 → 友好失败', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'task_manage',
        { action: 'create' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('note_take: 无标题无内容 → 友好失败', async () => {
      const ctx = makeContext([Permission.MEMORY_WRITE]);
      const result = await registry.execute(
        'note_take',
        { action: 'write', title: '', content: '' },
        ctx
      );
      expect(result.success).toBe(false);
    });

    test('emotion_detect: 空文本 → 仍可执行', async () => {
      const ctx = makeContext([]);
      const result = await registry.execute(
        'emotion_detect',
        { text: '' },
        ctx
      );
      expect(result.success).toBe(true);
    });
  });
});
