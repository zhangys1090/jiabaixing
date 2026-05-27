/**
 * 系统启动引导流程
 * V5.0 统一架构
 */

import { JiabaixingCore } from '../core/JiabaixingCore';
import { ScenarioAwareScheduler } from '../core/ScenarioAwareScheduler';
import { EvolutionOrchestrator } from '../evolution/EvolutionOrchestrator';
import { EvolutionEngine } from '../evolution/EvolutionEngine';
import { MemoryEngine, type MemoryItem } from '../memory/MemoryEngine';
import { isDuplicateContent } from '../harness/tools/memory/memory_store';
import { UserProfile } from '../memory/UserProfile';
import { EventBus } from '../shared/EventBus';
import { Logger } from '../utils/Logger';
import { EmojiManager } from '../interaction/EmojiManager';
import { InteractionEngine } from '../interaction/InteractionEngine';
import { EmotionAnalyzer } from '../multimodal/EmotionAnalyzer';
import { EnvironmentPerceptionEngine } from '../multimodal/EnvironmentPerceptionEngine';
import { SceneRecognizer } from '../multimodal/SceneRecognizer';
import { TRAEOptimizationIntegrator } from '../integration/TRAEOptimizationIntegrator';
import { AgentHarness } from '../harness';
import type { HarnessDeps } from '../harness/AgentHarness';
import type { HarnessToolDeps } from '../harness/tools/registerHarnessTools';

export function printBanner(): void {
  console.log('\n');
  console.log('  ===========================================================');
  console.log('  |                                                         |');
  console.log('  |   jiabaixing v5.0                                       |');
  console.log('  |                                                         |');
  console.log('  ===========================================================');
  console.log('');
}

export async function bootstrap(): Promise<JiabaixingCore> {
  console.log('  🚀 jiabaixing v5.0 启动中...\n');

  let core: JiabaixingCore;

  try {
    process.stdout.write('  🧠 核心引擎... ');
    core = new JiabaixingCore();
    console.log('✅');

    process.stdout.write('  🔒 安全模块... ');
    const { NetworkGuard } = await import('../security/NetworkGuard');
    NetworkGuard.install();
    const { DataSovereigntyPipeline } =
      await import('../security/DataSovereigntyPipeline');
    const sovereigntyPipeline = new DataSovereigntyPipeline();
    sovereigntyPipeline.initialize();
    console.log('✅');

    process.stdout.write('  💾 数据库... ');
    const memoryEngine = new MemoryEngine();
    await memoryEngine.initialize();

    core.setMemoryEngine(memoryEngine);

    const { UnifiedContextPipeline } =
      await import('../core/UnifiedContextPipeline');
    const contextPipeline = new UnifiedContextPipeline();
    contextPipeline.setMemoryEngine(memoryEngine);
    contextPipeline.setSovereigntyPipeline(sovereigntyPipeline);

    console.log('✅');

    process.stdout.write('  🎭 交互模块... ');
    const emojiManager = new EmojiManager();
    await emojiManager.initialize();
    console.log('✅');

    process.stdout.write('  🔧 技能系统... ');
    console.log('✅ (内置)');

    process.stdout.write('  🧠 推理引擎... ');
    const interactionEngine = new InteractionEngine();
    await interactionEngine.initialize();
    interactionEngine.setCore(core);

    const emotionAnalyzer = new EmotionAnalyzer();
    const sceneRecognizer = new SceneRecognizer();
    const environmentPerceptionEngine = new EnvironmentPerceptionEngine(
      emotionAnalyzer,
      sceneRecognizer
    );

    console.log('✅');

    process.stdout.write('  🧬 核心初始化... ');
    await core.initialize();
    console.log('✅');

    process.stdout.write('  📡 调度器... ');
    const scenarioScheduler = new ScenarioAwareScheduler();
    scenarioScheduler.setMemoryEngine(memoryEngine);

    core.setScenarioScheduler(scenarioScheduler);

    await scenarioScheduler.start();

    const { setSchedulerInstance } = await import('../routes/automation');
    setSchedulerInstance(scenarioScheduler);

    console.log('✅');

    process.stdout.write('  🧬 进化引擎... ');
    const { OptimizationResultDispatcher } =
      await import('../evolution/OptimizationResultDispatcher');
    const dispatcher = OptimizationResultDispatcher.getInstance();

    const ENABLE_AUTO_OPTIMIZE = process.env.ENABLE_AUTO_OPTIMIZE !== 'false';
    if (ENABLE_AUTO_OPTIMIZE) {
      const evolutionEngine = new EvolutionEngine(memoryEngine);
      evolutionEngine.start();

      core.setEvolutionEngine(evolutionEngine);

      const orchestrator = EvolutionOrchestrator.getInstance();
      orchestrator.registerEngines({
        evolutionEngine,
        llmProvider: core?.getLLM(),
      });
      orchestrator.start();

      dispatcher.registerConsumer(core.getPersonaCore());
      Logger.info(
        '✅ PersonaCore 已注册为优化消费者（语气调整闭环已连通）',
        'Bootstrap'
      );

      const toolWeightConsumer: import('../evolution/OptimizationResultDispatcher').OptimizationConsumer = {
        name: 'ToolWeightBridge',
        onOptimizationUpdate(snapshot: import('../evolution/OptimizationResultDispatcher').OptimizationSnapshot): void {
          const weights = snapshot.skillWeights;
          if (Object.keys(weights).length === 0) return;
          const harness = core.getHarness();
          if (harness) {
            const registry = harness.getToolRegistry();
            const tracker = registry?.getReliabilityTracker();
            if (tracker) {
              tracker.applyEvolutionWeights(weights);
              if (registry) {
                registry.invalidateCache();
              }
              Logger.info(
                `🔧 进化闭环: 技能权重已应用并刷新工具列表 [${Object.entries(weights).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ')}]`,
                'Bootstrap'
              );
            }
          }
        },
      };
      dispatcher.registerConsumer(toolWeightConsumer);
    }

    try {
      const traeOptimizationIntegrator = TRAEOptimizationIntegrator.getInstance();
      await traeOptimizationIntegrator.initialize();
      core.setTRAEOptimizationIntegrator(traeOptimizationIntegrator);
    } catch (error) {
      Logger.warn(
        `TRAE 优化系统初始化跳过（非必需）: ${(error as Error).message}`,
        'Bootstrap'
      );
    }
    console.log('✅');

    process.stdout.write('  🏗️ Harness 框架... ');
    let harness: import('../harness/AgentHarness').AgentHarness | null = null;
    try {
      const llm = core.getLLM();

      const userProfile = new UserProfile();
      await userProfile.load();

      const harnessDeps: HarnessDeps = {
        llm: {
          chatWithTools: (messages, tools) =>
            llm.chatWithTools(messages as never, tools),
          chat: (prompt, systemPrompt) =>
            llm.chat(prompt, [], systemPrompt),
        },
        constitutionalBuilder: core['constitutionPromptBuilder'],
        memoryInjector: {
          autoRetrieveMemories: async (input, _userId) => {
            const results = await memoryEngine.preciseHybridRetrieval(
              input,
              undefined,
              undefined,
              10
            );
            return results.map((r: { content: unknown }) =>
              typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
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
              hour < 6 ? '深夜' :
              hour < 9 ? '早晨' :
              hour < 12 ? '上午' :
              hour < 14 ? '中午' :
              hour < 18 ? '下午' :
              hour < 21 ? '傍晚' : '晚上';
            return `当前时间: ${now.toLocaleString('zh-CN')}，时段: ${timeOfDay}`;
          },
        },
        historyProvider: {
          getAllHistory: () => {
            const history = core['conversationHistoryManager'].getAll();
            return history.map(
              (h: { role: string; content: string; timestamp: Date }) => ({
                role: h.role as 'system' | 'user' | 'assistant' | 'tool',
                content: h.content,
              })
            );
          },
          getRecentHistory: (limit) => {
            const history = core['conversationHistoryManager'].getAll();
            return history.slice(-limit).map(
              (h: { role: string; content: string; timestamp: Date }) => ({
                role: h.role as 'system' | 'user' | 'assistant' | 'tool',
                content: h.content,
              })
            );
          },
        },
        persistenceDeps: {
          memoryEngine: memoryEngine ? {
            storeShortTermMemory: async (content: string, scene?: string, emotion?: string) =>
              memoryEngine.storeShortTermMemory(content, scene || '', emotion || 'neutral'),
            storeLongTermMemory: async (content: string, scene?: string, emotion?: string) =>
              memoryEngine.storeLongTermMemory(content, scene || '', emotion || 'neutral'),
            storeInstantMemory: async (content: string, scene?: string, emotion?: string) =>
              memoryEngine.storeInstantMemory(content, scene || '', emotion || 'neutral'),
            preciseHybridRetrieval: async (query: { query: string; scene?: string; emotion?: string; topK?: number }) => {
              const results = await memoryEngine.preciseHybridRetrieval(query.query, query.scene, query.emotion, query.topK || 5);
              return results.map((r) => ({
                id: r.id,
                content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
                type: r.type,
                timestamp: r.timestamp instanceof Date ? r.timestamp.getTime() : Date.now(),
                scene: r.scene,
                emotion: r.emotion,
                relevanceScore: r.relevanceScore,
              }));
            },
            storeFeedbackSignal: async (data: { feedbackType: string; rating?: number; message?: string; traceId?: string; toolName?: string; userId?: string; timestamp?: number }) =>
              memoryEngine.storeFeedbackSignal({
                feedbackType: (data.feedbackType as 'success' | 'failure' | 'timeout' | 'correction' | 'satisfaction') || 'success',
                rating: data.rating || 0,
                message: data.message || '',
                traceId: data.traceId,
                toolName: data.toolName,
                userId: data.userId,
                timestamp: data.timestamp,
              }),
          } : null,
          conversationHistory: core['conversationHistoryManager'] ? {
            addUserMessage: (content: string) => (core['conversationHistoryManager'] as any).addUserMessage?.(content),
            addAssistantMessage: (content: string) => (core['conversationHistoryManager'] as any).addAssistantMessage?.(content),
            getRecent: (count?: number) => {
              const all = (core['conversationHistoryManager'] as any).getAll?.() || [];
              return all.slice(-(count || 20)).map((h: { role: string; content: string }) => ({ role: h.role, content: h.content }));
            },
            formatForLLM: () => {
              const all = (core['conversationHistoryManager'] as any).getAll?.() || [];
              return all.map((h: { role: string; content: string }) => ({ role: h.role, content: h.content }));
            },
            saveState: async () => {},
            clear: async () => { (core['conversationHistoryManager'] as any).clear?.(); },
          } : null,
          userProfile: userProfile ? {
            load: () => userProfile.load(),
            save: () => userProfile.save(),
            getData: () => userProfile.toJSON() as import('../harness/persistence/PersistenceService').UserProfile,
            update: (data: import('../harness/persistence/PersistenceService').UserProfile) => userProfile.update(data as any),
          } : null,
        },
        evolutionEngine: {
          collectFeedback: (input, response, result, scene) => {
            const evo = core['evolutionEngine'] as { collectFeedback?: (...args: unknown[]) => void } | null;
            if (evo?.collectFeedback) {
              evo.collectFeedback(input, response, result, scene);
            }
          },
          assessQuality: (traceId, success, qualityScore, duration) => {
            const evo = core['evolutionEngine'] as { assessQuality?: (...args: unknown[]) => void } | null;
            if (evo?.assessQuality) {
              evo.assessQuality(traceId, success, qualityScore, duration);
            }
          },
        },
        personaCore: core.getPersonaCore(),
        evolutionExamples: {
          getPromptExamples: () => {
            const evo = core['evolutionEngine'] as { getStrategyOptimizer?: () => { getPromptExamples(): Array<{ trigger: string; correction: string; example: string; frequency: number }> } } | null;
            if (evo?.getStrategyOptimizer) {
              return evo.getStrategyOptimizer().getPromptExamples();
            }
            return [];
          },
        },
        toolDeps: {
          retrieveRelevant: async (query) => {
            const results = await memoryEngine.preciseHybridRetrieval(query.query, undefined, undefined, query.limit);
            return results;
          },
          storeShortTermMemory: async (content, category) => {
            await memoryEngine.storeShortTermMemory(content, category, 'neutral');
            return true;
          },
          checkDuplicate: async (content: string, category: string) => {
            const existing = await memoryEngine.preciseHybridRetrieval(content, category, undefined, 10);
            const existingContents = existing.map((r: MemoryItem) =>
              typeof r.content === 'string' ? r.content : JSON.stringify(r.content)
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
            const results = await memoryEngine.preciseHybridRetrieval(query, undefined, undefined, 5);
            for (const r of results) {
              const currentCount = (r as MemoryItem & { accessCount?: number }).accessCount ?? 0;
              (r as MemoryItem & { accessCount?: number }).accessCount = currentCount + 1;
              (r as MemoryItem & { lastAccessTime?: number }).lastAccessTime = Date.now();
            }
          },
          searchMemories: async (params) => {
            const results = await memoryEngine.preciseHybridRetrieval(params.keywords, undefined, undefined, params.limit);
            return results.map((r: MemoryItem) => ({
              content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
              category: params.category || r.scene || 'other',
              timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
            }));
          },
          detectEmotionFromInput: (text: string) => {
            const negativeWords = ['烦', '累', '难过', '焦虑', '生气', '失望', '沮丧', '压力', '崩溃'];
            const positiveWords = ['开心', '高兴', '喜欢', '棒', '好', '谢谢', '感谢', '幸福'];
            let score = 0;
            for (const w of negativeWords) { if (text.includes(w)) score--; }
            for (const w of positiveWords) { if (text.includes(w)) score++; }
            if (score <= -2) return { type: 'negative', intensity: Math.min(10, Math.abs(score) * 2) };
            if (score >= 2) return { type: 'positive', intensity: Math.min(10, score * 2) };
            return { type: 'neutral', intensity: 1 };
          },
          recognizeScene: async (text: string) => {
            const { MultimodalInput } = await import('../multimodal/MultimodalInput');
            const input = new MultimodalInput(text);
            const scene = await sceneRecognizer.recognize(input);
            return { type: scene.type, context: scene.context };
          },
          agentSelfReflection: {
            recordExecution: async (entry: unknown) => {
              Logger.info(`📝 自我反思已记录`, 'SelfReflect');
            },
          },
          captureScreen: async (params) => {
            const { ScreenCapture } = await import('../desktop/ScreenCapture');
            const capture = ScreenCapture.getInstance();
            const result = await capture.captureScreen(params?.screenIndex ?? 0);
            return { buffer: result.buffer, width: result.width, height: result.height };
          },
          listDirectory: async (params) => {
            const fs = await import('fs');
            const path = await import('path');
            const dir = params.directory || '.';
            const entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }> = [];
            try {
              const items = fs.readdirSync(dir, { withFileTypes: true });
              for (const item of items) {
                if (item.name.startsWith('.') && params.pattern !== '.*') continue;
                const fullPath = path.join(dir, item.name);
                entries.push({
                  name: item.name,
                  path: fullPath,
                  type: item.isDirectory() ? 'directory' : 'file',
                  size: item.isFile() ? fs.statSync(fullPath).size : undefined,
                });
              }
            } catch { /* directory not accessible */ }
            return entries;
          },
          searchInFiles: async (params) => {
            const fs = await import('fs');
            const path = await import('path');
            const results: Array<{ filePath: string; line: number; content: string; match: string }> = [];
            try {
              const dir = params.directory || '.';
              const maxResults = params.maxResults || 20;
              const files = fs.readdirSync(dir, { recursive: true });
              let count = 0;
              for (const file of files) {
                if (count >= maxResults) break;
                const filePath = typeof file === 'string' ? file : file.toString();
                const fullPath = path.join(dir, filePath);
                try {
                  if (!fs.statSync(fullPath).isFile()) continue;
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  const lines = content.split('\n');
                  for (let i = 0; i < lines.length && count < maxResults; i++) {
                    if (lines[i].includes(params.query)) {
                      results.push({ filePath: fullPath, line: i + 1, content: lines[i], match: params.query });
                      count++;
                    }
                  }
                } catch { /* skip unreadable files */ }
              }
            } catch { /* directory not accessible */ }
            return results;
          },
          addToHistory: async (filePath, entry) => {
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
            const result = await llm.chat(prompt, [], `你是一个专业的${params.language}程序员。`);
            return { code: result, language: params.language || 'typescript' };
          },
          analyzeCode: async (params) => {
            const prompt = `请分析以下${params.language}代码的${params.analysisType === 'security' ? '安全性' : params.analysisType === 'performance' ? '性能' : '质量'}问题：\n\n\`\`\`${params.language}\n${params.code}\n\`\`\`\n\n请返回JSON格式的分析结果，包括问题列表(issues)、质量评分(score 0-100)和总结(summary)。`;
            const llmResult = await llm.chat(prompt, [], `你是一个专业的代码质量分析师，擅长识别代码质量、安全和性能问题。请用JSON格式回答。`);
            try {
              const jsonMatch = llmResult.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                  issues: parsed.issues || [],
                  score: parsed.score || 70,
                  summary: parsed.summary || '代码分析完成'
                };
              }
            } catch { /* ignore parse errors */ }
            return { issues: [], score: 70, summary: `代码分析完成(${params.analysisType})，分析结果: ${llmResult.substring(0, 200)}` };
          },
          fixCode: async (params) => {
            const prompt = `修复以下${params.language}代码的问题: ${params.errorDescription}\n\n代码:\n${params.code}`;
            const result = await llm.chat(prompt, [], `你是一个专业的${params.language}程序员，专注于修复代码问题。`);
            return { fixedCode: result, changes: [{ type: 'fix' as const, description: params.errorDescription }] };
          },
          taskStore: {
            getTasks: async () => {
              const results = await memoryEngine.preciseHybridRetrieval('__tasks__', undefined, undefined, 100);
              return results.filter((r: MemoryItem) => r.scene === 'task').map((r: MemoryItem, i: number) => ({
                id: `task_${i}`,
                title: typeof r.content === 'string' ? r.content.substring(0, 50) : JSON.stringify(r.content).substring(0, 50),
                description: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
                priority: 'medium',
                status: 'pending' as const,
                tags: [],
                createdAt: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
              }));
            },
            saveTask: async (task) => {
              await memoryEngine.storeShortTermMemory(
                JSON.stringify(task),
                'task',
                'neutral'
              );
            },
            deleteTask: async () => {},
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
            deleteReminder: async () => {},
          },
          scheduleTrigger: (reminder) => {
            const triggerTime = new Date(reminder.triggerTime).getTime();
            const delay = triggerTime - Date.now();
            if (delay > 0) {
              setTimeout(() => {
                const { EventBus } = require('../shared/EventBus');
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
              const results = await memoryEngine.preciseHybridRetrieval('__notes__', undefined, undefined, 100);
              return results.filter((r: MemoryItem) => r.scene === 'note').map((r: MemoryItem, i: number) => ({
                id: `note_${i}`,
                title: typeof r.content === 'string' ? r.content.substring(0, 30) : JSON.stringify(r.content).substring(0, 30),
                content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
                tags: [],
                createdAt: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
                updatedAt: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
              }));
            },
            saveNote: async (note) => {
              await memoryEngine.storeShortTermMemory(
                JSON.stringify(note),
                'note',
                'neutral'
              );
            },
            deleteNote: async () => {},
          },
          getMemoryStats: () => ({ status: 'active', totalMemories: 0 }),
          getToolStats: () => ({ registered: 25, byCategory: {} }),
          getHarnessStats: () => ({ initialized: true, config: { useHarnessTools: true, useHarnessLoop: true } }),
          getEvolutionStats: () => ({}),
          getSchedulerStats: () => ({}),
          skillStore: {
            getSkills: async () => {
              const results = await memoryEngine.preciseHybridRetrieval('__skills__', undefined, undefined, 100);
              return results.filter((r: MemoryItem) => r.scene === 'skill').map((r: MemoryItem) => {
                try {
                  return JSON.parse(typeof r.content === 'string' ? r.content : JSON.stringify(r.content));
                } catch { return null; }
              }).filter(Boolean);
            },
            saveSkill: async (skill) => {
              await memoryEngine.storeShortTermMemory(JSON.stringify(skill), 'skill', 'neutral');
            },
            deleteSkill: async () => {},
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
                client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                  let data = '';
                  res.on('data', (chunk) => { data += chunk; });
                  res.on('end', () => resolve(data));
                  res.on('error', reject);
                }).on('error', reject);
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

      Logger.info('Harness 框架初始化完成', 'Bootstrap');
        } catch (err) {
          Logger.warn(
            `Harness 初始化失败: ${(err as Error).message}`,
            'Bootstrap'
          );
        }
        console.log('✅');

    process.stdout.write('  📡 网关隔离... ');
    const { GatewayBridge } = await import('../integration/GatewayBridge');
    const gatewayBridge = GatewayBridge.getInstance();

    gatewayBridge.setIncomingMessageHandler(async (message) => {
      Logger.info(`收到平台消息: ${message.platform}`, 'Bootstrap');

      if (harness) {
        const result = await harness.processInput({
          text: message.content,
          userId: message.from,
        });

        if (result.response && message.from && message.platform) {
          await gatewayBridge.sendMessage({
            platform: message.platform,
            message: result.response,
            to: message.from,
          });
        }
      }
    });

    try {
      await gatewayBridge.start();
      console.log('✅ (隔离进程模式)');
      Logger.info('网关启动成功: 隔离进程模式', 'Bootstrap');
    } catch (err) {
      Logger.warn(
        `网关隔离进程启动失败: ${(err as Error).message}，回退到内联模式`,
        'Bootstrap'
      );
      const { IntegrationManager } = await import(
        '../integration/IntegrationManager'
      );
      const integrationManager = IntegrationManager.getInstance();
      integrationManager.setCore(core);
      console.log('✅ (内联模式)');
      Logger.info('网关启动成功: 内联模式', 'Bootstrap');
    }

    EventBus.on('integration_message', async (data: unknown) => {
      try {
        const payload = data as {
          content: string;
          from?: string;
          platform?: string;
        };
        Logger.info(`收到平台消息: ${payload.platform}`, 'Bootstrap');

        if (harness) {
          const result = await harness.processInput({
            text: payload.content,
            userId: payload.from,
          });

          if (result.response && payload.from && payload.platform) {
            if (gatewayBridge.isWorkerAlive()) {
              await gatewayBridge.sendMessage({
                platform: payload.platform as any,
                message: result.response,
                to: payload.from,
              });
            } else {
              const { IntegrationManager } = await import('../integration/IntegrationManager');
              const im = IntegrationManager.getInstance();
              await im.sendMessage({
                platform: payload.platform as any,
                message: result.response,
                to: payload.from,
              });
            }
          }
        }
      } catch (error) {
        Logger.error('处理集成消息失败', error as Error, 'Bootstrap');
      }
    });

    console.log('\n  ✅ 系统就绪\n');
    Logger.info('系统初始化完成', 'Bootstrap');

    return core;
  } catch (error) {
    console.log('❌');
    Logger.error('❌ 初始化失败', error as Error, 'Bootstrap');
    process.exit(1);
  }
}
