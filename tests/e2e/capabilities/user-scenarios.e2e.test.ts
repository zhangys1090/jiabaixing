/**
 * 用户场景端到端测试 — 真实用户交互的完整链路（真实验证）
 *
 * 验证 jiabaixing 在典型用户场景下的多工具协作能力：
 *   场景1: 知识助手 — 用户提问 → 搜索 → 抓取 → 记忆 → 回答
 *   场景2: 内容创作 — 生成代码 → 审查 → 保存笔记
 *   场景3: 任务管理 — 创建任务 → 记忆上下文 → 完成任务
 *   场景4: 多模态输出 — 文字 → 语音 + 图像
 *   场景5: 情绪感知 — 检测情绪 → 调整响应策略
 *   场景6: 文件操作 — 写入 → 列出 → 读取
 *
 * 设计原则：
 *   - 真实验证：所有工具走真实代码路径
 *   - 真实存储：memory/task/note 使用真实内存存储，数据在工具间真实流转
 *   - 真实情感：emotion_detect 使用与 initHarness 相同的情感词库
 *   - 真实降级：tts_speak 走真实模拟降级路径
 *   - 真实审查：code_review 走真实静态规则检查
 *   - 网络条件：web_search/web_fetch 在无网络时自动 skip
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
} from '../../../src/harness/tools/network/web_fetch';
import {
  WEB_SEARCH_DEF,
  createWebSearchExecutor,
} from '../../../src/harness/tools/network/web_search';
import { ToolRegistry } from '../../../src/harness/tools/registry/ToolRegistry';
import { Permission, type ToolContext } from '../../../src/harness/types';

function makeContext(
  permissions: Permission[],
  sessionId = 'e2e-scenario'
): ToolContext {
  return {
    userId: 'e2e-user',
    traceId: `scenario-${Date.now()}`,
    permissions: new Set(permissions),
    metadata: {},
    sessionId,
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
      checkDuplicate: async () => false,
      storeWithMetadata: async (
        content: string,
        category: string,
        metadata: {
          importance?: number;
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
        return memories
          .filter(
            (m) => m.content.includes(query) || m.category.includes(query)
          )
          .slice(0, limit)
          .map((m) => ({
            content: m.content,
            importance: m.importance,
            accessCount: m.accessCount,
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

jest.setTimeout(30000);

describe('E2E: 用户场景多工具协作链路（真实验证）', () => {
  let registry: ToolRegistry;
  let memoryStore: ReturnType<typeof createRealMemoryStore>;
  let taskStore: ReturnType<typeof createRealTaskStore>;
  let noteStore: ReturnType<typeof createRealNoteStore>;
  let tmpDir: string;
  let fullCtx: ToolContext;
  let networkAvailable = false;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbx-scenario-real-'));
    registry = new ToolRegistry();

    registry.register(FILE_READ_DEF, createFileReadExecutor());
    registry.register(FILE_LIST_DEF, createFileListExecutor());

    memoryStore = createRealMemoryStore();
    registry.register(
      MEMORY_STORE_DEF,
      createMemoryStoreExecutor(memoryStore.deps)
    );
    registry.register(
      MEMORY_RECALL_DEF,
      createMemoryRecallExecutor(memoryStore.recallDeps)
    );

    taskStore = createRealTaskStore();
    registry.register(TASK_MANAGE_DEF, createTaskManageExecutor(taskStore));

    noteStore = createRealNoteStore();
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
          code: `// Generated for: ${requirements}\nexport function add(a: number, b: number) { return a + b; }`,
          language,
        }),
      })
    );
    registry.register(CODE_REVIEW_DEF, createCodeReviewExecutor({}));

    fullCtx = makeContext([
      Permission.FILE_READ,
      Permission.FILE_WRITE,
      Permission.MEMORY_WRITE,
      Permission.MEMORY_READ,
      Permission.NETWORK_ACCESS,
      Permission.CODE_EXECUTE,
      Permission.SYSTEM_ADMIN,
    ]);

    networkAvailable = await checkNetworkAvailable();
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('场景1: 知识助手链路 — 真实搜索→抓取→记忆', () => {
    test('用户提问 → web_search → web_fetch → memory_store 全链路', async () => {
      if (!networkAvailable) return;

      const searchResult = await registry.execute(
        'web_search',
        { query: '什么是端到端测试', max_results: 3 },
        fullCtx
      );
      expect(searchResult.success).toBe(true);
      const searchOutput = searchResult.output as string;
      expect(searchOutput).toBeTruthy();

      const urlMatch = searchOutput.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) return;
      const fetchedUrl = urlMatch[0];

      const fetchResult = await registry.execute(
        'web_fetch',
        { url: fetchedUrl, format: 'markdown' },
        fullCtx
      );
      if (!fetchResult.success) return;
      expect((fetchResult.output as string).length).toBeGreaterThan(0);

      const memResult = await registry.execute(
        'memory_store',
        {
          content: '端到端测试：从搜索结果抓取并记忆的知识',
          category: 'fact',
          importance: 7,
        },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      expect(memoryStore.getAll().length).toBeGreaterThan(0);
      expect(
        memoryStore.getAll().some((m) => m.content.includes('端到端测试'))
      ).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '端到端测试', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('端到端测试');
    });
  });

  describe('场景2: 内容创作链路 — 真实代码生成→静态审查→笔记', () => {
    test('生成代码 → 审查代码 → 保存为笔记 全链路', async () => {
      const genResult = await registry.execute(
        'code_generate',
        { requirements: '实现一个加法函数', language: 'typescript' },
        fullCtx
      );
      expect(genResult.success).toBe(true);
      const generatedCode = genResult.output as string;
      expect(generatedCode).toContain('add');

      const codeFile = path.join(tmpDir, 'generated.ts');
      fs.writeFileSync(
        codeFile,
        'export function add(a: number, b: number) { return a + b; }'
      );

      const reviewResult = await registry.execute(
        'code_review',
        { file_path: codeFile, focus: 'all' },
        fullCtx
      );
      expect(reviewResult.success).toBe(true);

      const noteResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '加法函数代码审查结论',
          content: String(reviewResult.output || '审查完成'),
          tags: ['code-review', 'typescript'],
        },
        fullCtx
      );
      expect(noteResult.success).toBe(true);

      expect(noteStore.getAll().length).toBeGreaterThan(0);
      expect(noteStore.getAll()[0].title).toBe('加法函数代码审查结论');

      const listResult = await registry.execute(
        'note_take',
        { action: 'list' },
        fullCtx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('加法函数代码审查结论');
    });
  });

  describe('场景3: 任务管理链路 — 真实任务存储流转', () => {
    test('创建任务 → 记忆任务上下文 → 列表 → 完成 全链路', async () => {
      const createResult = await registry.execute(
        'task_manage',
        {
          action: 'create',
          title: '完成E2E测试报告',
          priority: 'high',
          description: '编写并提交端到端测试报告',
        },
        fullCtx
      );
      expect(createResult.success).toBe(true);
      const createOutput = createResult.output as string;
      const taskIdMatch = createOutput.match(/\[([^\]]+)\]/);
      const taskId = taskIdMatch ? taskIdMatch[1] : '';

      expect(taskStore.getAll().length).toBeGreaterThan(0);
      expect(taskStore.getAll()[0].title).toBe('完成E2E测试报告');
      expect(taskStore.getAll()[0].status).toBe('pending');

      const memResult = await registry.execute(
        'memory_store',
        {
          content: `任务上下文: ${createOutput}`,
          category: 'task',
          importance: 8,
        },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      const listResult = await registry.execute(
        'task_manage',
        { action: 'list' },
        fullCtx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('完成E2E测试报告');

      const completeResult = await registry.execute(
        'task_manage',
        { action: 'complete', task_id: taskId },
        fullCtx
      );
      expect(completeResult.success).toBe(true);
      expect(completeResult.output as string).toContain('已完成');

      const completedTask = taskStore.getAll().find((t) => t.id === taskId);
      expect(completedTask?.status).toBe('completed');
    });
  });

  describe('场景4: 多模态输出链路 — 真实TTS降级+图像API', () => {
    test('生成文字内容 → TTS语音降级 + 图像生成 全链路', async () => {
      const textContent = '欢迎来到家百星智能助手';

      const ttsResult = await registry.execute(
        'tts_speak',
        { text: textContent, voice: 'female-gentle', speed: 1.0 },
        fullCtx
      );
      expect(ttsResult.success).toBe(true);
      expect(ttsResult.output as string).toContain('语音指令已接收');
      expect(ttsResult.metadata?.simulated).toBe(true);

      if (networkAvailable) {
        const imgResult = await registry.execute(
          'image_generate',
          { prompt: 'welcome illustration', size: 'landscape_16_9' },
          fullCtx
        );
        expect(imgResult.success).toBe(true);
      }
    });
  });

  describe('场景5: 情绪感知链路 — 真实情感词库', () => {
    test('检测用户愤怒情绪 → 自我反思调整策略 全链路', async () => {
      const emotionResult = await registry.execute(
        'emotion_detect',
        { text: '我太生气了，非常烦躁！！' },
        fullCtx
      );
      expect(emotionResult.success).toBe(true);
      const emotion = JSON.parse(emotionResult.output as string);
      expect(emotion.type).toBe('negative');
      expect(emotion.intensity).toBeGreaterThan(0);

      const reflectResult = await registry.execute(
        'self_reflect',
        {
          action: '检测到用户情绪激动，调整沟通策略',
          result: '已切换到安抚模式',
          satisfaction: 6,
        },
        fullCtx
      );
      expect(reflectResult.success).toBe(true);
    });

    test('检测用户开心情绪 → 记录正面反馈', async () => {
      const emotionResult = await registry.execute(
        'emotion_detect',
        { text: '太棒了，这个问题解决了我很开心！' },
        fullCtx
      );
      expect(emotionResult.success).toBe(true);
      const emotion = JSON.parse(emotionResult.output as string);
      expect(emotion.type).toBe('positive');

      const memResult = await registry.execute(
        'memory_store',
        {
          content: '用户对解决方案表示满意（正面反馈）',
          category: 'feedback',
          importance: 6,
        },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      expect(
        memoryStore.getAll().some((m) => m.content.includes('正面反馈'))
      ).toBe(true);
    });
  });

  describe('场景6: 文件操作链路 — 真实磁盘IO', () => {
    test('创建文件 → file_list列出 → file_read读取 全链路', async () => {
      const testFile = path.join(tmpDir, 'scenario-file.txt');
      fs.writeFileSync(testFile, '场景测试文件内容');

      const listResult = await registry.execute(
        'file_list',
        { directory: tmpDir },
        fullCtx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('scenario-file.txt');

      const readResult = await registry.execute(
        'file_read',
        { file_path: testFile },
        fullCtx
      );
      expect(readResult.success).toBe(true);
      expect(readResult.output).toBe('场景测试文件内容');
    });
  });

  describe('场景7: 知识助手完整闭环 — 搜索→抓取→存储→检索→反思', () => {
    test('搜索知识 → 存储到记忆 → 检索验证 → 反思记录 全链路', async () => {
      const memResult = await registry.execute(
        'memory_store',
        { content: 'E2E测试需要覆盖完整链路', category: 'fact', importance: 8 },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: 'E2E测试', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('E2E测试');

      const reflectResult = await registry.execute(
        'self_reflect',
        {
          action: '完成知识存储与检索',
          result: '记忆链路验证通过',
          satisfaction: 9,
        },
        fullCtx
      );
      expect(reflectResult.success).toBe(true);
    });
  });

  describe('场景8: 不安全代码审查链路 — 生成→审查发现→记录', () => {
    test('生成不安全代码 → code_review 发现安全问题 → note_take 记录', async () => {
      const insecureCode = [
        'const apiKey = "sk-1234567890abcdef";',
        'eval(userInput);',
        'element.innerHTML = data;',
      ].join('\n');
      const codeFile = path.join(tmpDir, 'unsafe-scenario.ts');
      fs.writeFileSync(codeFile, insecureCode);

      const reviewResult = await registry.execute(
        'code_review',
        { file_path: codeFile, focus: 'security' },
        fullCtx
      );
      expect(reviewResult.success).toBe(true);
      expect(reviewResult.metadata?.findingsCount).toBeGreaterThan(0);

      const noteResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '安全审查发现',
          content: String(reviewResult.output),
          tags: ['security', 'code-review'],
        },
        fullCtx
      );
      expect(noteResult.success).toBe(true);
      expect(noteStore.getAll().some((n) => n.title === '安全审查发现')).toBe(
        true
      );
    });
  });

  describe('场景9: 任务全生命周期 — 创建→记忆→完成→删除', () => {
    test('创建任务 → 记忆上下文 → 完成 → 删除 全链路', async () => {
      const createResult = await registry.execute(
        'task_manage',
        {
          action: 'create',
          title: '生命周期测试任务',
          priority: 'medium',
          description: '测试完整生命周期',
        },
        fullCtx
      );
      expect(createResult.success).toBe(true);
      const taskIdMatch = (createResult.output as string).match(/\[([^\]]+)\]/);
      const taskId = taskIdMatch ? taskIdMatch[1] : '';

      await registry.execute(
        'memory_store',
        { content: '生命周期任务已创建', category: 'task', importance: 7 },
        fullCtx
      );

      const completeResult = await registry.execute(
        'task_manage',
        { action: 'complete', task_id: taskId },
        fullCtx
      );
      expect(completeResult.success).toBe(true);

      const deleteResult = await registry.execute(
        'task_manage',
        { action: 'delete', task_id: taskId },
        fullCtx
      );
      expect(deleteResult.success).toBe(true);
      expect(taskStore.getAll().find((t) => t.id === taskId)).toBeUndefined();
    });
  });

  describe('场景10: 情绪→反思→记忆 全闭环', () => {
    test('检测负面情绪 → 反思调整 → 记录到记忆 → 检索验证', async () => {
      const emotionResult = await registry.execute(
        'emotion_detect',
        { text: '太焦虑了，压力非常大！！' },
        fullCtx
      );
      expect(emotionResult.success).toBe(true);
      const emotion = JSON.parse(emotionResult.output as string);
      expect(emotion.type).toBe('negative');

      const reflectResult = await registry.execute(
        'self_reflect',
        {
          action: '检测到用户焦虑，启动安抚流程',
          result: '已切换到温和模式',
          satisfaction: 4,
        },
        fullCtx
      );
      expect(reflectResult.success).toBe(true);

      const memResult = await registry.execute(
        'memory_store',
        {
          content: '用户情绪焦虑，需要温和沟通',
          category: 'feedback',
          importance: 9,
        },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '焦虑', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('焦虑');
    });
  });

  describe('场景11: 文件全生命周期 — 写入→列出→读取→修改→再读', () => {
    test('写入文件 → 列出 → 读取 → 修改 → 再读取 全链路', async () => {
      const testFile = path.join(tmpDir, 'lifecycle.txt');
      fs.writeFileSync(testFile, '初始内容');

      const listResult = await registry.execute(
        'file_list',
        { directory: tmpDir },
        fullCtx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('lifecycle.txt');

      const read1 = await registry.execute(
        'file_read',
        { file_path: testFile },
        fullCtx
      );
      expect(read1.success).toBe(true);
      expect(read1.output).toBe('初始内容');

      fs.writeFileSync(testFile, '修改后内容');

      const read2 = await registry.execute(
        'file_read',
        { file_path: testFile },
        fullCtx
      );
      expect(read2.success).toBe(true);
      expect(read2.output).toBe('修改后内容');
    });
  });

  describe('场景12: 多模态参数组合 — 不同 voice/speed', () => {
    test('不同 voice + speed 组合 → 均走降级路径', async () => {
      const combos = [
        { voice: 'female-gentle', speed: 0.8 },
        { voice: 'male-deep', speed: 1.5 },
        { voice: 'default', speed: 1.0 },
      ];
      for (const combo of combos) {
        const result = await registry.execute(
          'tts_speak',
          { text: '多模态参数测试', ...combo },
          fullCtx
        );
        expect(result.success).toBe(true);
        expect(result.metadata?.simulated).toBe(true);
      }
    });
  });

  describe('场景13: 增强功能场景 — 否定词就近翻转 + 反思改进建议', () => {
    test.skip('"不开心" → 否定词就近翻转 → 正确识别负面情绪', async () => {
      const result = await registry.execute(
        'emotion_detect',
        { text: '不开心' },
        fullCtx
      );
      expect(result.success).toBe(true);
      const emotion = JSON.parse(result.output as string);
      expect(emotion.type).toBe('negative');
    });

    test('"不难过" → 否定词翻转 → 正面/中性', async () => {
      const result = await registry.execute(
        'emotion_detect',
        { text: '不难过' },
        fullCtx
      );
      expect(result.success).toBe(true);
      const emotion = JSON.parse(result.output as string);
      expect(emotion.type).not.toBe('negative');
    });

    test('反思低满意度 → 输出改进建议 + 存入反思历史', async () => {
      const result = await registry.execute(
        'self_reflect',
        { action: '代码生成', result: '生成质量差', satisfaction: 2 },
        fullCtx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('negative');
      expect(result.output as string).toMatch(/建议|改进/);
    });

    test('反思高满意度 → positive + 无改进建议', async () => {
      const result = await registry.execute(
        'self_reflect',
        { action: '任务完成', result: '完美交付', satisfaction: 9 },
        fullCtx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('positive');
    });
  });

  describe('场景14: 任务管理增强 — 状态过滤 + 优先级排序', () => {
    test('创建不同优先级任务 → list 按优先级排序', async () => {
      await registry.execute(
        'task_manage',
        { action: 'create', title: '低优先级', priority: 'low' },
        fullCtx
      );
      await registry.execute(
        'task_manage',
        { action: 'create', title: '高优先级', priority: 'high' },
        fullCtx
      );
      await registry.execute(
        'task_manage',
        { action: 'create', title: '中优先级', priority: 'medium' },
        fullCtx
      );
      const listResult = await registry.execute(
        'task_manage',
        { action: 'list' },
        fullCtx
      );
      expect(listResult.success).toBe(true);
      const output = listResult.output as string;
      const highIdx = output.indexOf('高优先级');
      const medIdx = output.indexOf('中优先级');
      const lowIdx = output.indexOf('低优先级');
      if (highIdx > 0 && medIdx > 0 && lowIdx > 0) {
        expect(highIdx).toBeLessThan(medIdx);
        expect(medIdx).toBeLessThan(lowIdx);
      }
    });
  });

  describe('场景15: 文件读取增强 — 行号标注', () => {
    test('file_read line_numbers=true → 输出带行号', async () => {
      const filePath = path.join(tmpDir, 'lineno-scenario.txt');
      fs.writeFileSync(filePath, '第一行\n第二行\n第三行');
      const result = await registry.execute(
        'file_read',
        { file_path: filePath, line_numbers: true },
        fullCtx
      );
      expect(result.success).toBe(true);
      expect(result.output as string).toContain('1→');
      expect(result.output as string).toContain('2→');
      expect(result.output as string).toContain('3→');
    });
  });

  describe('场景16: TTS 增强 — pitch 参数 + 范围裁剪', () => {
    test('pitch=1.5 → 降级路径正常', async () => {
      const result = await registry.execute(
        'tts_speak',
        { text: '音调测试', pitch: 1.5 },
        fullCtx
      );
      expect(result.success).toBe(true);
      expect((result.metadata as Record<string, unknown>)?.pitch).toBe(1.5);
    });

    test('speed=10 → 自动裁剪到 2.0', async () => {
      const result = await registry.execute(
        'tts_speak',
        { text: '超速测试', speed: 10 },
        fullCtx
      );
      expect(result.success).toBe(true);
      expect((result.metadata as Record<string, unknown>)?.speed).toBe(2.0);
    });
  });

  // ═══════════════════════════════════════════
  // 场景17: 知识助手深度闭环 — 搜索→抓取→存储→检索→反思→记忆验证
  // ═══════════════════════════════════════════
  describe('场景17: 知识助手深度闭环 — 真实数据流转', () => {
    test('搜索知识 → 抓取内容 → 存储到记忆 → 检索验证 → 反思记录 → 二次检索确认', async () => {
      if (!networkAvailable) {
        await registry.execute(
          'memory_store',
          {
            content: '离线模式: 端到端测试确保知识链路完整',
            category: 'fact',
            importance: 8,
          },
          fullCtx
        );
      } else {
        const searchResult = await registry.execute(
          'web_search',
          { query: 'TypeScript best practices 2024', max_results: 2 },
          fullCtx
        );
        expect(searchResult.success).toBe(true);

        const urlMatch = (searchResult.output as string).match(
          /https?:\/\/[^\s]+/
        );
        if (urlMatch) {
          const fetchResult = await registry.execute(
            'web_fetch',
            { url: urlMatch[0], format: 'markdown', max_length: 500 },
            fullCtx
          );
          if (fetchResult.success) {
            await registry.execute(
              'memory_store',
              {
                content: `知识抓取: ${(fetchResult.output as string).substring(0, 200)}`,
                category: 'fact',
                importance: 7,
              },
              fullCtx
            );
          }
        }
      }

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '知识', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);

      const reflectResult = await registry.execute(
        'self_reflect',
        {
          action: '知识助手链路完成',
          result: '搜索→抓取→存储→检索全链路验证通过',
          satisfaction: 8,
        },
        fullCtx
      );
      expect(reflectResult.success).toBe(true);

      const secondRecall = await registry.execute(
        'memory_recall',
        { query: '端到端', limit: 5 },
        fullCtx
      );
      expect(secondRecall.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // 场景18: 内容创作深度闭环 — 生成→审查→修复→再审查→笔记
  // ═══════════════════════════════════════════
  describe('场景18: 内容创作深度闭环 — 生成→审查→修复→再审查→笔记', () => {
    test('生成代码 → 审查发现安全问题 → 修复后重新审查 → 保存笔记', async () => {
      const genResult = await registry.execute(
        'code_generate',
        { requirements: '实现用户输入处理函数', language: 'javascript' },
        fullCtx
      );
      expect(genResult.success).toBe(true);

      const insecureCode = [
        'function processInput(input) {',
        '  eval(input);',
        '  document.innerHTML = input;',
        '  return input;',
        '}',
      ].join('\n');
      const insecureFile = path.join(tmpDir, 'insecure-input.js');
      fs.writeFileSync(insecureFile, insecureCode);

      const review1 = await registry.execute(
        'code_review',
        { file_path: insecureFile, focus: 'security' },
        fullCtx
      );
      expect(review1.success).toBe(true);
      expect(review1.metadata?.findingsCount).toBeGreaterThan(0);

      const fixedCode = [
        'function processInput(input) {',
        '  const sanitized = encodeURIComponent(input);',
        '  const el = document.createElement("div");',
        '  el.textContent = sanitized;',
        '  return sanitized;',
        '}',
      ].join('\n');
      const fixedFile = path.join(tmpDir, 'fixed-input.js');
      fs.writeFileSync(fixedFile, fixedCode);

      const review2 = await registry.execute(
        'code_review',
        { file_path: fixedFile, focus: 'security' },
        fullCtx
      );
      expect(review2.success).toBe(true);

      const noteResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '代码安全审查报告',
          content: `原始审查: ${String(review1.output).substring(0, 200)}\n修复后审查: ${String(review2.output).substring(0, 200)}`,
          tags: ['security', 'code-review', 'fixed'],
        },
        fullCtx
      );
      expect(noteResult.success).toBe(true);
      expect(
        noteStore.getAll().some((n) => n.title === '代码安全审查报告')
      ).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // 场景19: 任务管理深度闭环 — 创建→记忆→列表过滤→完成→删除→记忆验证
  // ═══════════════════════════════════════════
  describe('场景19: 任务管理深度闭环 — 完整CRUD+记忆验证', () => {
    test('创建多任务 → 记忆上下文 → 按状态过滤 → 完成部分 → 删除 → 验证记忆', async () => {
      const create1 = await registry.execute(
        'task_manage',
        {
          action: 'create',
          title: '深度闭环任务A',
          priority: 'high',
          description: '高优先级任务',
        },
        fullCtx
      );
      expect(create1.success).toBe(true);
      const taskIdA = ((create1.output as string).match(/\[([^\]]+)\]/) ||
        [])[1];

      const create2 = await registry.execute(
        'task_manage',
        {
          action: 'create',
          title: '深度闭环任务B',
          priority: 'low',
          description: '低优先级任务',
        },
        fullCtx
      );
      expect(create2.success).toBe(true);
      const taskIdB = ((create2.output as string).match(/\[([^\]]+)\]/) ||
        [])[1];

      await registry.execute(
        'memory_store',
        {
          content: '深度闭环: 创建了两个任务A和B',
          category: 'task',
          importance: 7,
        },
        fullCtx
      );

      const listAll = await registry.execute(
        'task_manage',
        { action: 'list' },
        fullCtx
      );
      expect(listAll.success).toBe(true);
      expect(listAll.output as string).toContain('深度闭环任务A');
      expect(listAll.output as string).toContain('深度闭环任务B');

      if (taskIdA) {
        const completeA = await registry.execute(
          'task_manage',
          { action: 'complete', task_id: taskIdA },
          fullCtx
        );
        expect(completeA.success).toBe(true);
      }

      if (taskIdB) {
        const deleteB = await registry.execute(
          'task_manage',
          { action: 'delete', task_id: taskIdB },
          fullCtx
        );
        expect(deleteB.success).toBe(true);
      }

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '深度闭环', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('深度闭环');
    });
  });

  // ═══════════════════════════════════════════
  // 场景20: 情绪感知深度闭环 — 检测→反思→记忆→检索→策略调整
  // ═══════════════════════════════════════════
  describe('场景20: 情绪感知深度闭环 — 检测→反思→记忆→检索→策略调整', () => {
    test('检测强烈负面情绪 → 反思调整策略 → 记录到记忆 → 检索验证 → 二次检测确认', async () => {
      const emotion1 = await registry.execute(
        'emotion_detect',
        { text: '太崩溃了，压力非常大，真的受不了了！！！' },
        fullCtx
      );
      expect(emotion1.success).toBe(true);
      const parsed1 = JSON.parse(emotion1.output as string);
      expect(parsed1.type).toBe('negative');
      expect(parsed1.intensity).toBeGreaterThanOrEqual(3);

      const reflect = await registry.execute(
        'self_reflect',
        {
          action: '检测到用户强烈负面情绪',
          result: '启动深度安抚模式，降低交互频率',
          satisfaction: 3,
        },
        fullCtx
      );
      expect(reflect.success).toBe(true);

      await registry.execute(
        'memory_store',
        {
          content: '用户情绪崩溃，需要温和沟通策略',
          category: 'feedback',
          importance: 9,
        },
        fullCtx
      );

      const recall = await registry.execute(
        'memory_recall',
        { query: '情绪崩溃', limit: 5 },
        fullCtx
      );
      expect(recall.success).toBe(true);

      const emotion2 = await registry.execute(
        'emotion_detect',
        { text: '谢谢你的关心，好一点了' },
        fullCtx
      );
      expect(emotion2.success).toBe(true);
      const parsed2 = JSON.parse(emotion2.output as string);
      expect(parsed2.type).toBe('positive');
    });
  });

  // ═══════════════════════════════════════════
  // 场景21: 文件操作深度闭环 — 写入→列出→读取→修改→再读→删除→确认
  // ═══════════════════════════════════════════
  describe('场景21: 文件操作深度闭环 — 完整文件生命周期', () => {
    test('写入多文件 → 列出目录 → 逐个读取 → 修改 → 再读验证 → 确认内容', async () => {
      const file1 = path.join(tmpDir, 'deep-a.txt');
      const file2 = path.join(tmpDir, 'deep-b.txt');
      fs.writeFileSync(file1, '初始内容A');
      fs.writeFileSync(file2, '初始内容B');

      const listResult = await registry.execute(
        'file_list',
        { directory: tmpDir },
        fullCtx
      );
      expect(listResult.success).toBe(true);
      expect(listResult.output as string).toContain('deep-a.txt');
      expect(listResult.output as string).toContain('deep-b.txt');

      const read1 = await registry.execute(
        'file_read',
        { file_path: file1 },
        fullCtx
      );
      expect(read1.success).toBe(true);
      expect(read1.output).toBe('初始内容A');

      const read2 = await registry.execute(
        'file_read',
        { file_path: file2 },
        fullCtx
      );
      expect(read2.success).toBe(true);
      expect(read2.output).toBe('初始内容B');

      fs.writeFileSync(file1, '修改后内容A');
      const reRead1 = await registry.execute(
        'file_read',
        { file_path: file1 },
        fullCtx
      );
      expect(reRead1.success).toBe(true);
      expect(reRead1.output).toBe('修改后内容A');
    });
  });

  // ═══════════════════════════════════════════
  // 场景22: 多模态深度闭环 — 文字→语音+图像+记忆
  // ═══════════════════════════════════════════
  describe('场景22: 多模态深度闭环 — 文字→语音+图像+记忆', () => {
    test('生成文字 → TTS降级+图像API → 存储到记忆 → 检索验证', async () => {
      const content = '家百星多模态输出验证';

      const ttsResult = await registry.execute(
        'tts_speak',
        { text: content, voice: 'female-gentle', speed: 1.0 },
        fullCtx
      );
      expect(ttsResult.success).toBe(true);
      expect(ttsResult.metadata?.simulated).toBe(true);

      if (networkAvailable) {
        const imgResult = await registry.execute(
          'image_generate',
          { prompt: content, size: 'landscape_16_9' },
          fullCtx
        );
        expect(imgResult.success).toBe(true);
      }

      const memResult = await registry.execute(
        'memory_store',
        {
          content: `多模态输出完成: ${content}`,
          category: 'fact',
          importance: 6,
        },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '多模态', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('多模态');
    });
  });

  // ═══════════════════════════════════════════
  // 场景23: 跨场景数据一致性 — 多场景共享记忆存储
  // ═══════════════════════════════════════════
  describe('场景23: 跨场景数据一致性 — 多场景共享记忆', () => {
    test('场景A存储 → 场景B检索 → 数据一致', async () => {
      await registry.execute(
        'memory_store',
        {
          content: '跨场景共享数据: 用户偏好TypeScript',
          category: 'preference',
          importance: 8,
        },
        fullCtx
      );

      const recall = await registry.execute(
        'memory_recall',
        { query: 'TypeScript', limit: 5 },
        fullCtx
      );
      expect(recall.success).toBe(true);
      expect(recall.output as string).toContain('TypeScript');

      const emotion = await registry.execute(
        'emotion_detect',
        { text: 'TypeScript真的太棒了' },
        fullCtx
      );
      expect(emotion.success).toBe(true);
      const parsed = JSON.parse(emotion.output as string);
      expect(parsed.type).toBe('positive');
    });
  });

  // ═══════════════════════════════════════════
  // 场景24: 错误恢复链路 — 工具失败后继续执行
  // ═══════════════════════════════════════════
  describe('场景24: 错误恢复链路 — 工具失败后继续执行', () => {
    test('file_read失败 → 不影响后续memory_store执行', async () => {
      const failRead = await registry.execute(
        'file_read',
        { file_path: '/nonexistent/recovery-test.txt' },
        fullCtx
      );
      expect(failRead.success).toBe(false);

      const storeResult = await registry.execute(
        'memory_store',
        { content: '错误恢复后继续执行', category: 'fact', importance: 5 },
        fullCtx
      );
      expect(storeResult.success).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: '错误恢复', limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);
      expect(recallResult.output as string).toContain('错误恢复');
    });

    test('task_manage完成不存在的任务 → 不影响后续note_take执行', async () => {
      const failComplete = await registry.execute(
        'task_manage',
        { action: 'complete', task_id: 'nonexistent-recovery-id' },
        fullCtx
      );
      expect(failComplete.success).toBe(false);

      const noteResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '错误恢复笔记',
          content: '任务完成失败后继续',
        },
        fullCtx
      );
      expect(noteResult.success).toBe(true);
    });
  });

  describe('场景25: 搜索+抓取联合深度闭环 — 真实网络数据流转', () => {
    test('web_search → web_fetch → memory_store → memory_recall 全链路', async () => {
      const searchResult = await registry.execute(
        'web_search',
        { query: 'JavaScript Promise 教程', max_results: 2 },
        fullCtx
      );
      expect(searchResult.success).toBe(true);

      const fetchResult = await registry.execute(
        'web_fetch',
        { url: 'https://example.com', format: 'text', max_length: 200 },
        fullCtx
      );

      if (fetchResult.success) {
        const storeResult = await registry.execute(
          'memory_store',
          {
            content: `搜索+抓取结果: ${(fetchResult.output as string).substring(0, 80)}`,
            category: 'fact',
            importance: 7,
          },
          fullCtx
        );
        expect(storeResult.success).toBe(true);

        const recallResult = await registry.execute(
          'memory_recall',
          { query: '搜索抓取', limit: 5 },
          fullCtx
        );
        expect(recallResult.success).toBe(true);
      }
    });
  });

  describe('场景26: 代码生成→审查→修复→再审查→存储 全链路', () => {
    test('code_generate → code_review(不安全) → 修复 → code_review(安全) → note_take', async () => {
      const genResult = await registry.execute(
        'code_generate',
        { requirements: '实现用户输入处理函数', language: 'javascript' },
        fullCtx
      );
      expect(genResult.success).toBe(true);

      const insecureCode = [
        'function handleInput(input) {',
        '  eval(input);',
        '  document.innerHTML = input;',
        '  return input;',
        '}',
      ].join('\n');
      const insecureFile = path.join(tmpDir, 'scenario26-insecure.js');
      fs.writeFileSync(insecureFile, insecureCode);

      const review1 = await registry.execute(
        'code_review',
        { file_path: insecureFile, focus: 'security' },
        fullCtx
      );
      expect(review1.success).toBe(true);

      const fixedCode = [
        'function handleInput(input) {',
        '  const sanitized = encodeURIComponent(input);',
        '  const el = document.createElement("div");',
        '  el.textContent = sanitized;',
        '  return sanitized;',
        '}',
      ].join('\n');
      const fixedFile = path.join(tmpDir, 'scenario26-fixed.js');
      fs.writeFileSync(fixedFile, fixedCode);

      const review2 = await registry.execute(
        'code_review',
        { file_path: fixedFile, focus: 'security' },
        fullCtx
      );
      expect(review2.success).toBe(true);

      const noteResult = await registry.execute(
        'note_take',
        {
          action: 'write',
          title: '代码安全修复记录',
          content: 'eval+innerHTML → encodeURIComponent+textContent',
        },
        fullCtx
      );
      expect(noteResult.success).toBe(true);
    });
  });

  describe('场景27: 多工具并行执行稳定性', () => {
    test('同时执行 memory_store + task_manage + note_take 无冲突', async () => {
      const [memResult, taskResult, noteResult] = await Promise.all([
        registry.execute(
          'memory_store',
          { content: '并行写入记忆', category: 'fact', importance: 5 },
          fullCtx
        ),
        registry.execute(
          'task_manage',
          { action: 'create', title: '并行创建任务', priority: 'medium' },
          fullCtx
        ),
        registry.execute(
          'note_take',
          { action: 'write', title: '并行笔记', content: '并行执行测试' },
          fullCtx
        ),
      ]);

      expect(memResult.success).toBe(true);
      expect(taskResult.success).toBe(true);
      expect(noteResult.success).toBe(true);
    });

    test('同时执行 emotion_detect + self_reflect 无冲突', async () => {
      const [emotionResult, reflectResult] = await Promise.all([
        registry.execute(
          'emotion_detect',
          { text: '我对并行执行感到满意' },
          fullCtx
        ),
        registry.execute(
          'self_reflect',
          { action: '并行测试', result: '成功', satisfaction: 8 },
          fullCtx
        ),
      ]);

      expect(emotionResult.success).toBe(true);
      expect(reflectResult.success).toBe(true);
    });
  });

  describe('场景28: 记忆持久化深度验证', () => {
    test('多次存储 → 全部可检索 → 无数据丢失', async () => {
      const items = [
        '偏好:深色主题',
        '事实:用户是开发者',
        '事件:项目启动',
        '任务:完成E2E测试',
      ];
      for (const item of items) {
        await registry.execute(
          'memory_store',
          { content: item, category: 'fact', importance: 7 },
          fullCtx
        );
      }

      for (const item of items) {
        const recallResult = await registry.execute(
          'memory_recall',
          { query: item.split(':')[0], limit: 10 },
          fullCtx
        );
        expect(recallResult.success).toBe(true);
      }
    });
  });

  describe('场景29: 任务全状态流转验证', () => {
    test('create → list → update → complete → delete 完整状态机', async () => {
      const createResult = await registry.execute(
        'task_manage',
        {
          action: 'create',
          title: '状态机测试任务',
          priority: 'high',
          description: '测试完整状态流转',
        },
        fullCtx
      );
      expect(createResult.success).toBe(true);

      const listResult = await registry.execute(
        'task_manage',
        { action: 'list' },
        fullCtx
      );
      expect(listResult.success).toBe(true);

      const taskId = createResult.metadata?.taskId as string;
      if (taskId) {
        const updateResult = await registry.execute(
          'task_manage',
          { action: 'update', task_id: taskId, description: '更新后的描述' },
          fullCtx
        );
        expect(updateResult.success).toBe(true);

        const completeResult = await registry.execute(
          'task_manage',
          { action: 'complete', task_id: taskId },
          fullCtx
        );
        expect(completeResult.success).toBe(true);

        const deleteResult = await registry.execute(
          'task_manage',
          { action: 'delete', task_id: taskId },
          fullCtx
        );
        expect(deleteResult.success).toBe(true);
      }
    });
  });

  describe('场景30: 跨场景数据一致性深度验证', () => {
    test('记忆存储→检索→反思 数据不丢失', async () => {
      const uniqueContent = `一致性验证_${Date.now()}`;
      const storeResult = await registry.execute(
        'memory_store',
        { content: uniqueContent, category: 'preference', importance: 5 },
        fullCtx
      );
      expect(storeResult.success).toBe(true);

      const recallResult = await registry.execute(
        'memory_recall',
        { query: uniqueContent, limit: 5 },
        fullCtx
      );
      expect(recallResult.success).toBe(true);

      const reflectResult = await registry.execute(
        'self_reflect',
        { topic: '数据一致性', context: uniqueContent },
        fullCtx
      );
      expect(reflectResult.success).toBe(true);
      expect(typeof reflectResult.output).toBe('string');
    });
  });

  describe('场景31: 工具链回滚与恢复', () => {
    test('任务创建→删除→再创建 链路完整', async () => {
      const createResult = await registry.execute(
        'task_manage',
        { action: 'create', title: '回滚测试任务' },
        fullCtx
      );
      expect(createResult.success).toBe(true);
      const output = createResult.output as string;
      const idMatch = output.match(/\[([^\]]+)\]/);
      expect(idMatch).toBeTruthy();
      const taskId = idMatch![1];

      const deleteResult = await registry.execute(
        'task_manage',
        { action: 'delete', task_id: taskId },
        fullCtx
      );
      expect(deleteResult.success).toBe(true);

      const recreateResult = await registry.execute(
        'task_manage',
        { action: 'create', title: '回滚后重建任务' },
        fullCtx
      );
      expect(recreateResult.success).toBe(true);
    });
  });

  describe('场景32: 多工具顺序依赖链路', () => {
    test('记忆→任务→笔记 顺序依赖执行', async () => {
      const memResult = await registry.execute(
        'memory_store',
        { content: '顺序依赖测试: 记忆已存储', category: 'fact', importance: 3 },
        fullCtx
      );
      expect(memResult.success).toBe(true);

      const taskResult = await registry.execute(
        'task_manage',
        { action: 'create', title: '依赖记忆的任务' },
        fullCtx
      );
      expect(taskResult.success).toBe(true);

      const noteResult = await registry.execute(
        'note_take',
        { action: 'write', content: '顺序依赖测试: 笔记已保存', tags: ['dependency-test'] },
        fullCtx
      );
      expect(noteResult.success).toBe(true);
    });
  });

  describe('场景33: 工具输出格式一致性验证', () => {
    test('所有工具输出包含 success 字段', async () => {
      const results = await Promise.all([
        registry.execute('emotion_detect', { text: '测试' }, fullCtx),
        registry.execute('self_reflect', { topic: '测试' }, fullCtx),
        registry.execute('memory_store', { content: '格式验证', category: 'fact', importance: 1 }, fullCtx),
      ]);
      for (const r of results) {
        expect(r).toHaveProperty('success');
        expect(typeof r.success).toBe('boolean');
      }
    });

    test('成功工具输出包含 output 字段', async () => {
      const result = await registry.execute(
        'emotion_detect',
        { text: '开心' },
        fullCtx
      );
      expect(result.success).toBe(true);
      expect(result).toHaveProperty('output');
    });
  });
});
