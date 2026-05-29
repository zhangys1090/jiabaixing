import { AgentHarness } from '../../harness';
import type { HarnessDeps } from '../../harness/AgentHarness';
import type { HarnessToolDeps } from '../../harness/tools/registerHarnessTools';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { isDuplicateContent } from '../../harness/tools/memory/memory_store';
import { UserProfile } from '../../memory/UserProfile';
import { MemoryEngine, type MemoryItem } from '../../memory/MemoryEngine';
import { SceneRecognizer } from '../../multimodal/SceneRecognizer';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';
import { MCPToolBridge } from '../../harness/tools/registry/MCPToolBridge';
import { AutonomousTrigger } from '../../harness/loop/AutonomousTrigger';
import fs from 'fs';
import path from 'path';

export interface HarnessInitResult {
  harness: import('../../harness/AgentHarness').AgentHarness | null;
}

export async function initHarness(
  core: JiabaixingCore,
  memoryEngine: MemoryEngine,
  sceneRecognizer: SceneRecognizer
): Promise<HarnessInitResult> {
  let harness: import('../../harness/AgentHarness').AgentHarness | null = null;
  try {
    const llm = core.getLLM();

    const userProfile = new UserProfile();
    await userProfile.load();

    const constitutionPromptBuilder = core.getConstitutionPromptBuilder();
    const conversationHistoryManager = core.getConversationHistoryManager();
    const evolutionEngine = core.getEvolutionEngineInternal();

    const harnessDeps: HarnessDeps = {
      llm: {
        chatWithTools: (messages, tools) =>
          llm.chatWithTools(messages as never, tools),
        chat: (prompt, systemPrompt) => llm.chat(prompt, [], systemPrompt),
      },
      constitutionalBuilder: constitutionPromptBuilder,
      memoryInjector: {
        autoRetrieveMemories: async (input, _userId) => {
          const results = await memoryEngine.preciseHybridRetrieval(
            input,
            undefined,
            undefined,
            10
          );
          return results.map((r: { content: unknown }) =>
            typeof r.content === 'string'
              ? r.content
              : JSON.stringify(r.content)
          );
        },
      },
      memoryStore: {
        storeConversation: async (input, response, metadata) => {
          try {
            const summary = `用户: ${input.substring(0, 200)}\n助手: ${response.substring(0, 500)}`;
            await memoryEngine.storeShortTermMemory(
              summary,
              'conversation',
              'neutral'
            );
            if (metadata.quality && Number(metadata.quality) >= 0.8) {
              await memoryEngine.storeLongTermMemory(
                summary,
                'conversation',
                'neutral'
              );
            }
            Logger.debug(
              `💾 对话已持久化 (quality=${metadata.quality})`,
              'MemoryStore'
            );
          } catch (err) {
            Logger.warn(
              `对话持久化失败: ${(err as Error).message}`,
              'MemoryStore'
            );
          }
        },
      },
      dynamicContext: {
        getDynamicContext: () => {
          const now = new Date();
          const hour = now.getHours();
          const timeOfDay =
            hour < 6
              ? '深夜'
              : hour < 9
                ? '早晨'
                : hour < 12
                  ? '上午'
                  : hour < 14
                    ? '中午'
                    : hour < 18
                      ? '下午'
                      : hour < 21
                        ? '傍晚'
                        : '晚上';
          return `当前时间: ${now.toLocaleString('zh-CN')}，时段: ${timeOfDay}`;
        },
      },
      historyProvider: {
        getAllHistory: () => {
          const history = conversationHistoryManager.getAll();
          return history.map(
            (h: { role: string; content: string; timestamp: Date }) => ({
              role: h.role as 'system' | 'user' | 'assistant' | 'tool',
              content: h.content,
            })
          );
        },
        getRecentHistory: (limit) => {
          const history = conversationHistoryManager.getAll();
          return history
            .slice(-limit)
            .map((h: { role: string; content: string; timestamp: Date }) => ({
              role: h.role as 'system' | 'user' | 'assistant' | 'tool',
              content: h.content,
            }));
        },
      },
      persistenceDeps: {
        memoryEngine: memoryEngine
          ? {
              storeShortTermMemory: async (
                content: string,
                scene?: string,
                emotion?: string
              ) =>
                memoryEngine.storeShortTermMemory(
                  content,
                  scene || '',
                  emotion || 'neutral'
                ),
              storeLongTermMemory: async (
                content: string,
                scene?: string,
                emotion?: string
              ) =>
                memoryEngine.storeLongTermMemory(
                  content,
                  scene || '',
                  emotion || 'neutral'
                ),
              storeInstantMemory: async (
                content: string,
                scene?: string,
                emotion?: string
              ) =>
                memoryEngine.storeInstantMemory(
                  content,
                  scene || '',
                  emotion || 'neutral'
                ),
              preciseHybridRetrieval: async (query: {
                query: string;
                scene?: string;
                emotion?: string;
                topK?: number;
              }) => {
                const results = await memoryEngine.preciseHybridRetrieval(
                  query.query,
                  query.scene,
                  query.emotion,
                  query.topK || 5
                );
                return results.map((r) => ({
                  id: r.id,
                  content:
                    typeof r.content === 'string'
                      ? r.content
                      : JSON.stringify(r.content),
                  type: r.type,
                  timestamp:
                    r.timestamp instanceof Date
                      ? r.timestamp.getTime()
                      : Date.now(),
                  scene: r.scene,
                  emotion: r.emotion,
                  relevanceScore: r.relevanceScore,
                }));
              },
              storeFeedbackSignal: async (data: {
                feedbackType: string;
                rating?: number;
                message?: string;
                traceId?: string;
                toolName?: string;
                userId?: string;
                timestamp?: number;
              }) =>
                memoryEngine.storeFeedbackSignal({
                  feedbackType:
                    (data.feedbackType as
                      | 'success'
                      | 'failure'
                      | 'timeout'
                      | 'correction'
                      | 'satisfaction') || 'success',
                  rating: data.rating || 0,
                  message: data.message || '',
                  traceId: data.traceId,
                  toolName: data.toolName,
                  userId: data.userId,
                  timestamp: data.timestamp,
                }),
            }
          : null,
        conversationHistory: conversationHistoryManager
          ? (() => {
              const chm = conversationHistoryManager as unknown as {
                addUserMessage?: (content: string) => void;
                addAssistantMessage?: (content: string) => void;
                getAll?: () => Array<{ role: string; content: string }>;
                clear?: () => void;
              };
              return {
                addUserMessage: (content: string) =>
                  chm.addUserMessage?.(content),
                addAssistantMessage: (content: string) =>
                  chm.addAssistantMessage?.(content),
                getRecent: (count?: number) => {
                  const all = chm.getAll?.() || [];
                  return all
                    .slice(-(count || 20))
                    .map((h: { role: string; content: string }) => ({
                      role: h.role,
                      content: h.content,
                    }));
                },
                formatForLLM: () => {
                  const all = chm.getAll?.() || [];
                  return all.map((h: { role: string; content: string }) => ({
                    role: h.role,
                    content: h.content,
                  }));
                },
                saveState: async () => {},
                clear: async () => {
                  chm.clear?.();
                },
              };
            })()
          : null,
        userProfile: userProfile
          ? {
              load: () => userProfile.load(),
              save: () => userProfile.save(),
              getData: () =>
                userProfile.toJSON() as import('../../harness/persistence/PersistenceService').UserProfile,
              update: (
                data: import('../../harness/persistence/PersistenceService').UserProfile
              ) =>
                userProfile.update(
                  data as unknown as import('../../memory/UserProfile').UserProfileUpdateData
                ),
            }
          : null,
      },
      evolutionEngine: {
        collectFeedback: (input, response, result, scene) => {
          if (evolutionEngine?.collectFeedback) {
            evolutionEngine.collectFeedback(input, response, result, scene);
          }
        },
        assessQuality: (traceId, success, qualityScore, duration) => {
          if (evolutionEngine?.assessQuality) {
            evolutionEngine.assessQuality(
              traceId,
              success,
              qualityScore,
              duration
            );
          }
        },
      },
      personaCore: core.getPersonaCore(),
      skillRegistry: SkillRegistry.getInstance(),
      evolutionExamples: {
        getPromptExamples: () => {
          if (evolutionEngine?.getStrategyOptimizer) {
            return evolutionEngine.getStrategyOptimizer().getPromptExamples();
          }
          return [];
        },
      },
      environmentSensor: {
        getEnvironmentContext: () => {
          try {
            // 从调度器缓存中获取最新环境快照
            const scheduler = core.getScenarioScheduler();
            if (scheduler) {
              const snapshot = scheduler.getEnvironmentSnapshot?.();
              if (snapshot?.foregroundWindow?.title) {
                const fg = snapshot.foregroundWindow;
                const proc = (fg.process || '').toLowerCase();
                const title = fg.title.toLowerCase();
                let env = 'other';
                if (
                  title.includes('code') ||
                  title.includes('vscode') ||
                  proc.includes('code') ||
                  title.includes('terminal') ||
                  proc.includes('terminal') ||
                  proc.includes('cmd') ||
                  proc.includes('powershell') ||
                  proc.includes('bash') ||
                  proc.includes('cursor')
                ) {
                  env = 'coding';
                } else if (
                  proc.includes('chrome') ||
                  proc.includes('edge') ||
                  proc.includes('firefox') ||
                  proc.includes('explorer')
                ) {
                  env = 'browsing';
                }
                return `当前环境: ${env === 'coding' ? '编程中' : env === 'browsing' ? '浏览网页' : '其他'}\n前台窗口: ${fg.title}`;
              }
            }
          } catch {
            /* ignore */
          }
          return '';
        },
      },
      toolDeps: {
        retrieveRelevant: async (query) => {
          const results = await memoryEngine.preciseHybridRetrieval(
            query.query,
            undefined,
            undefined,
            query.limit
          );
          return results;
        },
        storeShortTermMemory: async (content, category) => {
          await memoryEngine.storeShortTermMemory(content, category, 'neutral');
          return true;
        },
        checkDuplicate: async (content: string, category: string) => {
          const existing = await memoryEngine.preciseHybridRetrieval(
            content,
            category,
            undefined,
            10
          );
          const existingContents = existing.map((r: MemoryItem) =>
            typeof r.content === 'string'
              ? r.content
              : JSON.stringify(r.content)
          );
          return isDuplicateContent(content, existingContents);
        },
        storeWithMetadata: async (content, category, metadata) => {
          await memoryEngine.storeShortTermMemory(
            JSON.stringify({ content, metadata }),
            category,
            'neutral'
          );
          return true;
        },
        updateAccessStats: async (query: string) => {
          const results = await memoryEngine.preciseHybridRetrieval(
            query,
            undefined,
            undefined,
            5
          );
          for (const r of results) {
            const currentCount =
              (r as MemoryItem & { accessCount?: number }).accessCount ?? 0;
            (r as MemoryItem & { accessCount?: number }).accessCount =
              currentCount + 1;
            (r as MemoryItem & { lastAccessTime?: number }).lastAccessTime =
              Date.now();
          }
        },
        searchMemories: async (params) => {
          const results = await memoryEngine.preciseHybridRetrieval(
            params.keywords,
            undefined,
            undefined,
            params.limit
          );
          return results.map((r: MemoryItem) => ({
            content:
              typeof r.content === 'string'
                ? r.content
                : JSON.stringify(r.content),
            category: params.category || r.scene || 'other',
            timestamp: r.timestamp
              ? new Date(r.timestamp).getTime()
              : Date.now(),
          }));
        },
        detectEmotionFromInput: (text: string) => {
          // 扩展情感词库 + 上下文强度分析
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
            '烦躁',
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
            '极其',
          ];
          const negations = ['不', '没', '别', '不要', '不是', '没有'];
          let words: string[] = [];
          try {
            words = text
              .split(/[\s,，。！？、；：""''（）()！？\n]+/)
              .filter(Boolean);
          } catch {
            words = [text];
          }

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
              text.match(
                new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
              ) || []
            ).length;
            if (count > 0) {
              matchedNeg += count;
              score -= count * (hasIntensifier ? 2 : 1);
            }
          }
          for (const w of positiveWords) {
            const count = (
              text.match(
                new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
              ) || []
            ).length;
            if (count > 0) {
              matchedPos += count;
              score += count * (hasIntensifier ? 2 : 1);
            }
          }

          // 否定词翻转情绪极性
          if (hasNegation && Math.abs(score) > 0) {
            // 只在紧挨情绪词时翻转，简单处理：整句翻转
            score = -score;
          }

          // 感叹号增强强度
          const exclaimCount =
            (text.match(/！/g) || []).length + (text.match(/!/g) || []).length;
          if (exclaimCount >= 2) {
            score *= 1.5;
          }

          // 问号表示困惑/中性偏负
          const questionCount =
            (text.match(/？/g) || []).length + (text.match(/\?/g) || []).length;
          if (questionCount >= 3 && matchedNeg === 0 && matchedPos === 0) {
            score -= 1;
          }

          if (score <= -2) {
            const rawIntensity = Math.min(10, Math.abs(score) * 1.5);
            return {
              type: 'negative' as const,
              intensity: Math.round(rawIntensity * 10) / 10,
            };
          }
          if (score >= 2) {
            const rawIntensity = Math.min(10, score * 1.5);
            return {
              type: 'positive' as const,
              intensity: Math.round(rawIntensity * 10) / 10,
            };
          }
          return { type: 'neutral' as const, intensity: 1 };
        },
        recognizeScene: async (text: string) => {
          const { MultimodalInput } =
            await import('../../multimodal/MultimodalInput');
          const input = new MultimodalInput(text);
          const scene = await sceneRecognizer.recognize(input);
          return { type: scene.type, context: scene.context };
        },
        agentSelfReflection: {
          recordExecution: async (entry: unknown) => {
            try {
              const entryStr =
                typeof entry === 'string' ? entry : JSON.stringify(entry);
              const refDir = path.join(process.cwd(), 'data', 'reflections');
              fs.mkdirSync(refDir, { recursive: true });
              const refFile = path.join(
                refDir,
                `reflection_${Date.now()}.json`
              );
              fs.writeFileSync(
                refFile,
                JSON.stringify(
                  {
                    timestamp: new Date().toISOString(),
                    entry: entryStr,
                  },
                  null,
                  2
                ),
                'utf-8'
              );
              Logger.info(`📝 自我反思已持久化: ${refFile}`, 'SelfReflect');
            } catch (err) {
              Logger.warn(
                `⚠️ 自我反思持久化失败: ${(err as Error).message}`,
                'SelfReflect'
              );
            }
          },
        },
        captureScreen: async (params) => {
          const { ScreenCapture } = await import('../../desktop/ScreenCapture');
          const capture = ScreenCapture.getInstance();
          const result = await capture.captureScreen(params?.screenIndex ?? 0);
          return {
            buffer: result.buffer,
            width: result.width,
            height: result.height,
          };
        },
        listDirectory: async (params) => {
          const dir = params.directory || '.';
          const entries: Array<{
            name: string;
            path: string;
            type: 'file' | 'directory';
            size?: number;
          }> = [];
          try {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (item.name.startsWith('.') && params.pattern !== '.*')
                continue;
              const fullPath = path.join(dir, item.name);
              entries.push({
                name: item.name,
                path: fullPath,
                type: item.isDirectory() ? 'directory' : 'file',
                size: item.isFile() ? fs.statSync(fullPath).size : undefined,
              });
            }
          } catch {
            /* directory not accessible */
          }
          return entries;
        },
        searchInFiles: async (params) => {
          const results: Array<{
            filePath: string;
            line: number;
            content: string;
            match: string;
          }> = [];
          try {
            const dir = params.directory || '.';
            const maxResults = params.maxResults || 20;
            const files: string[] = fs.readdirSync(dir);
            let count = 0;
            for (const file of files) {
              if (count >= maxResults) break;
              const fullPath = path.join(dir, file);
              try {
                if (!fs.statSync(fullPath).isFile()) continue;
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && count < maxResults; i++) {
                  if (lines[i].includes(params.query)) {
                    results.push({
                      filePath: fullPath,
                      line: i + 1,
                      content: lines[i],
                      match: params.query,
                    });
                    count++;
                  }
                }
              } catch {
                /* skip unreadable files */
              }
            }
          } catch {
            /* directory not accessible */
          }
          return results;
        },
        addToHistory: async (filePath, _entry) => {
          Logger.info(`📝 文件变更历史: ${filePath}`, 'FileHistory');
        },
        removeHistory: async (_filePath, _steps) => null,
        getHistory: async (_filePath) => [],
        validateCodeSyntax: (code, _ext) => {
          const errors: string[] = [];
          const openBraces = (code.match(/\{/g) || []).length;
          const closeBraces = (code.match(/\}/g) || []).length;
          if (openBraces !== closeBraces) errors.push('大括号不匹配');
          const openParens = (code.match(/\(/g) || []).length;
          const closeParens = (code.match(/\)/g) || []).length;
          if (openParens !== closeParens) errors.push('圆括号不匹配');
          return errors;
        },
        generateCode: async (params) => {
          const prompt = `请用${params.language}实现: ${params.requirements}${params.framework ? `，使用${params.framework}框架` : ''}`;
          const result = await llm.chat(
            prompt,
            [],
            `你是一个专业的${params.language}程序员。`
          );
          return { code: result, language: params.language || 'typescript' };
        },
        analyzeCode: async (params) => {
          const prompt = `请分析以下${params.language}代码的${params.analysisType === 'security' ? '安全性' : params.analysisType === 'performance' ? '性能' : '质量'}问题：\n\n\`\`\`${params.language}\n${params.code}\n\`\`\`\n\n请返回JSON格式的分析结果，包括问题列表(issues)、质量评分(score 0-100)和总结(summary)。`;
          const llmResult = await llm.chat(
            prompt,
            [],
            `你是一个专业的代码质量分析师，擅长识别代码质量、安全和性能问题。请用JSON格式回答。`
          );
          try {
            const jsonMatch = llmResult.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              return {
                issues: parsed.issues || [],
                score: parsed.score || 70,
                summary: parsed.summary || '代码分析完成',
              };
            }
          } catch {
            /* ignore parse errors */
          }
          return {
            issues: [],
            score: 70,
            summary: `代码分析完成(${params.analysisType})，分析结果: ${llmResult.substring(0, 200)}`,
          };
        },
        fixCode: async (params) => {
          const prompt = `修复以下${params.language}代码的问题: ${params.errorDescription}\n\n代码:\n${params.code}`;
          const result = await llm.chat(
            prompt,
            [],
            `你是一个专业的${params.language}程序员，专注于修复代码问题。`
          );
          return {
            fixedCode: result,
            changes: [
              { type: 'fix' as const, description: params.errorDescription },
            ],
          };
        },
        taskStore: {
          getTasks: async () => {
            const results = await memoryEngine.preciseHybridRetrieval(
              '__tasks__',
              undefined,
              undefined,
              100
            );
            return results
              .filter((r: MemoryItem) => r.scene === 'task')
              .map((r: MemoryItem, i: number) => ({
                id: `task_${i}`,
                title:
                  typeof r.content === 'string'
                    ? r.content.substring(0, 50)
                    : JSON.stringify(r.content).substring(0, 50),
                description:
                  typeof r.content === 'string'
                    ? r.content
                    : JSON.stringify(r.content),
                priority: 'medium',
                status: 'pending' as const,
                tags: [],
                createdAt: r.timestamp
                  ? new Date(r.timestamp).getTime()
                  : Date.now(),
              }));
          },
          saveTask: async (task) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify(task),
              'task',
              'neutral'
            );
          },
          deleteTask: async (taskId: string) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify({
                _deleted: true,
                id: taskId,
                deletedAt: Date.now(),
              }),
              'task',
              'neutral'
            );
            Logger.info(`🗑️ 任务已标记删除: ${taskId}`, 'TaskStore');
          },
        },
        calendarStore: {
          getEvents: async () => [],
          saveEvent: async (event) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify(event),
              'calendar',
              'neutral'
            );
          },
          deleteEvent: async (eventId: string) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify({
                _deleted: true,
                id: eventId,
                deletedAt: Date.now(),
              }),
              'calendar',
              'neutral'
            );
            Logger.info(`🗑️ 日程已标记删除: ${eventId}`, 'CalendarStore');
          },
        },
        reminderStore: {
          getReminders: async () => [],
          saveReminder: async (reminder) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify(reminder),
              'reminder',
              'neutral'
            );
          },
          deleteReminder: async (reminderId: string) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify({
                _deleted: true,
                id: reminderId,
                deletedAt: Date.now(),
              }),
              'reminder',
              'neutral'
            );
            Logger.info(`🗑️ 提醒已标记删除: ${reminderId}`, 'ReminderStore');
          },
        },
        scheduleTrigger: (reminder) => {
          const triggerTime = new Date(reminder.triggerTime).getTime();
          const delay = triggerTime - Date.now();
          if (delay > 0) {
            setTimeout(() => {
              const { EventBus } = require('../../shared/EventBus');
              void EventBus.emit('reminder_triggered', {
                reminderId: reminder.id,
                message: reminder.message,
                timestamp: new Date().toISOString(),
              });
            }, delay);
          }
        },
        noteStore: {
          getNotes: async () => {
            const results = await memoryEngine.preciseHybridRetrieval(
              '__notes__',
              undefined,
              undefined,
              100
            );
            return results
              .filter((r: MemoryItem) => r.scene === 'note')
              .map((r: MemoryItem, i: number) => ({
                id: `note_${i}`,
                title:
                  typeof r.content === 'string'
                    ? r.content.substring(0, 30)
                    : JSON.stringify(r.content).substring(0, 30),
                content:
                  typeof r.content === 'string'
                    ? r.content
                    : JSON.stringify(r.content),
                tags: [],
                createdAt: r.timestamp
                  ? new Date(r.timestamp).getTime()
                  : Date.now(),
                updatedAt: r.timestamp
                  ? new Date(r.timestamp).getTime()
                  : Date.now(),
              }));
          },
          saveNote: async (note) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify(note),
              'note',
              'neutral'
            );
          },
          deleteNote: async (noteId: string) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify({
                _deleted: true,
                id: noteId,
                deletedAt: Date.now(),
              }),
              'note',
              'neutral'
            );
            Logger.info(`🗑️ 笔记已标记删除: ${noteId}`, 'NoteStore');
          },
        },
        getMemoryStats: () => {
          const memDir = path.join(process.cwd(), 'data');
          let totalMemories = 0;
          let shortTermSize = 0;
          try {
            const shortTermFile = path.join(memDir, 'short_term_memory.json');
            if (fs.existsSync(shortTermFile)) {
              const content = fs.readFileSync(shortTermFile, 'utf-8');
              const lines = content
                .trim()
                .split('\n')
                .filter((l: string) => !!l);
              shortTermSize = content.length;
              totalMemories += lines.length;
            }
            const profileFile = path.join(memDir, 'user_profile.json');
            if (fs.existsSync(profileFile)) {
              totalMemories +=
                JSON.parse(fs.readFileSync(profileFile, 'utf-8')).interactions
                  ?.length || 0;
            }
          } catch {
            /* 忽略读取错误 */
          }
          return {
            status: 'active',
            totalMemories,
            shortTermSize,
            dbPath: path.join(memDir, 'jiabaixing_memory.db'),
          };
        },
        getToolStats: () => {
          const tools = harness?.getToolRegistry();
          const allTools = tools?.getAll() || [];
          const byCategory: Record<string, number> = {};
          for (const t of allTools) {
            const cat = t.definition.category;
            byCategory[cat] = (byCategory[cat] || 0) + 1;
          }
          return { registered: allTools.length, byCategory };
        },
        getHarnessStats: () => ({
          initialized: true,
          config: { useHarnessTools: true, useHarnessLoop: true },
          loopRounds: 0,
          toolCalls: 0,
          uptime: process.uptime(),
        }),
        getEvolutionStats: () => {
          const orchestrator = (() => {
            try {
              return require('../../evolution/EvolutionOrchestrator').EvolutionOrchestrator.getInstance();
            } catch {
              return null;
            }
          })();
          if (!orchestrator) return {};
          const metrics = orchestrator.getUnifiedMetrics();
          return {
            totalInteractions: metrics.summary.totalInteractions,
            totalOptimizations: metrics.summary.totalOptimizations,
            averageQualityScore: metrics.summary.averageQualityScore,
            qualityTrend: metrics.quality.trend,
            failureRate: metrics.quality.failureRate,
            cyclesToday: metrics.optimization.cyclesToday,
            totalCycles: metrics.optimization.totalCycles,
            lastCycleTime: metrics.optimization.lastCycleTime,
            cycleSuccessRate: metrics.optimization.successRate,
          };
        },
        getSchedulerStats: () => ({
          active: true,
          triggers: 0,
        }),
        skillStore: {
          getSkills: async () => {
            const results = await memoryEngine.preciseHybridRetrieval(
              '__skills__',
              undefined,
              undefined,
              100
            );
            return results
              .filter((r: MemoryItem) => r.scene === 'skill')
              .map((r: MemoryItem) => {
                try {
                  return JSON.parse(
                    typeof r.content === 'string'
                      ? r.content
                      : JSON.stringify(r.content)
                  );
                } catch {
                  return null;
                }
              })
              .filter((x: unknown) => !!x);
          },
          saveSkill: async (skill) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify(skill),
              'skill',
              'neutral'
            );
          },
          deleteSkill: async (skillName: string) => {
            await memoryEngine.storeShortTermMemory(
              JSON.stringify({
                _deleted: true,
                name: skillName,
                deletedAt: Date.now(),
              }),
              'skill',
              'neutral'
            );
            Logger.info(`🗑️ 技能已标记删除: ${skillName}`, 'SkillStore');
          },
        },
        llm: {
          chat: async (prompt, _history, systemPrompt) => {
            return llm.chat(prompt, [], systemPrompt);
          },
        },
        httpClient: {
          get: async (url: string) => {
            const https = await import('https');
            const http = await import('http');
            return new Promise<string>((resolve, reject) => {
              const client = url.startsWith('https') ? https : http;
              client
                .get(
                  url,
                  { headers: { 'User-Agent': 'Mozilla/5.0' } },
                  (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                      data += chunk;
                    });
                    res.on('end', () => resolve(data));
                    res.on('error', reject);
                  }
                )
                .on('error', reject);
            });
          },
        },
      } satisfies HarnessToolDeps,
    };

    harness = new AgentHarness({
      useHarnessTools: true,
      useHarnessLoop: true,
      useHarnessContext: true,
      useHarnessVerification: true,
      useHarnessConstraints: true,
      useHarnessPersistence: true,
    });

    harness.setDeps(harnessDeps);
    await harness.initialize();

    core.setHarness(harness);

    const mcpBridge = MCPToolBridge.getInstance();
    if (harness.getToolRegistry) {
      const registry = harness.getToolRegistry();
      if (registry) {
        mcpBridge.startAutoSync(registry);
        Logger.info('🌉 MCP工具桥接已启动', 'Bootstrap');
      }
    }

    const autoTrigger = AutonomousTrigger.getInstance();
    if (harness) {
      autoTrigger.setHarness(harness);
      autoTrigger.start();
      Logger.info('🤖 自主触发器已启动', 'Bootstrap');
    }

    Logger.info('Harness 框架初始化完成', 'Bootstrap');
  } catch (err) {
    Logger.warn(`Harness 初始化失败: ${(err as Error).message}`, 'Bootstrap');
  }

  return { harness };
}
