/**
 * Phase 3 集成测试 — 会话增强 + Skill/Cron
 *
 * 验证调用链路：
 *   AgentHarness.initialize → SessionStore/CronJobScheduler/SkillRegistry 创建
 *   AgentHarness.shutdown   → SessionStore.close / CronJobScheduler.stop
 *   initHarness             → 动态注入 sessionStore/skillRegistry 到 toolDeps
 */

import { CronJobScheduler } from '../../src/cron/CronJobScheduler';
import { AgentHarness } from '../../src/harness/AgentHarness';
import { SessionStore } from '../../src/persistence/SessionStore';
import { SkillRegistry } from '../../src/skills/SkillRegistry';

// ── SessionStore 单元测试 ──────────────────────────────

describe('Phase 3 集成测试 - 会话增强 + Skill/Cron', () => {
  beforeAll(() => {
    CronJobScheduler.resetInstance(true);
    SkillRegistry.resetInstance();
  });

  afterEach(() => {
    CronJobScheduler.resetInstance(true);
    SkillRegistry.resetInstance();
  });

  // ── SessionStore ────────────────────────────────────

  describe('SessionStore 会话存储', () => {
    let store: SessionStore;

    beforeEach(() => {
      store = new SessionStore(`data/test-session-${Date.now()}.db`);
    });

    afterEach(() => {
      try {
        store.close();
      } catch {
        /* best-effort */
      }
    });

    test('应该创建会话', () => {
      store.createSession({
        id: 'test-session-1',
        source: 'cli',
        userId: 'user1',
        model: 'gpt-4',
      });
      const session = store.getSession('test-session-1');
      expect(session).toBeDefined();
      expect(session!.id).toBe('test-session-1');
      expect(session!.source).toBe('cli');
      expect(session!.userId).toBe('user1');
    });

    test('应该追加消息并更新计数', () => {
      store.createSession({
        id: 'test-session-2',
        source: 'api',
      });
      store.appendMessage({
        sessionId: 'test-session-2',
        role: 'user',
        content: 'Hello',
      });
      store.appendMessage({
        sessionId: 'test-session-2',
        role: 'assistant',
        content: 'Hi there!',
      });

      const session = store.getSession('test-session-2');
      expect(session!.messageCount).toBe(2);

      const messages = store.getMessages('test-session-2');
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    test('应该结束会话', () => {
      store.createSession({
        id: 'test-session-3',
        source: 'cli',
      });
      store.endSession('test-session-3', 'completed');

      const session = store.getSession('test-session-3');
      expect(session!.endedAt).toBeDefined();
      expect(session!.endReason).toBe('completed');
    });

    test('应该搜索消息', () => {
      store.createSession({
        id: 'test-session-4',
        source: 'cli',
      });
      store.appendMessage({
        sessionId: 'test-session-4',
        role: 'user',
        content: 'How to implement binary search in Python?',
      });

      const results = store.searchMessages('binary search');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].snippet).toContain('binary');
    });

    test('应该获取统计信息', () => {
      const stats = store.getStats();
      expect(stats).toHaveProperty('sessions');
      expect(stats).toHaveProperty('messages');
    });

    test('应该设置会话标题', () => {
      store.createSession({
        id: 'test-session-5',
        source: 'cli',
      });
      store.setSessionTitle('test-session-5', 'My Conversation');

      const session = store.getSession('test-session-5');
      expect(session!.title).toBe('My Conversation');
    });

    test('应该更新 token 统计', () => {
      store.createSession({
        id: 'test-session-6',
        source: 'cli',
      });
      store.updateSessionTokens('test-session-6', 100, 200, 0.003);

      const session = store.getSession('test-session-6');
      expect(session!.inputTokens).toBe(100);
      expect(session!.outputTokens).toBe(200);
    });

    test('应该列出会话', () => {
      store.createSession({ id: 'list-1', source: 'cli' });
      store.createSession({ id: 'list-2', source: 'api' });

      const all = store.getSessions(10);
      expect(all.length).toBeGreaterThanOrEqual(2);

      const cliOnly = store.getSessions(10, 'cli');
      expect(cliOnly.every((s) => s.source === 'cli')).toBe(true);
    });

    test('应该删除会话', () => {
      store.createSession({ id: 'del-1', source: 'cli' });
      store.deleteSession('del-1');

      const session = store.getSession('del-1');
      expect(session).toBeUndefined();
    });

    test('应该获取对话格式', () => {
      store.createSession({ id: 'conv-1', source: 'cli' });
      store.appendMessage({
        sessionId: 'conv-1',
        role: 'user',
        content: 'Hello',
      });
      store.appendMessage({
        sessionId: 'conv-1',
        role: 'assistant',
        content: 'Hi!',
      });

      const conv = store.getConversation('conv-1');
      expect(conv).toHaveLength(2);
      expect(conv[0]).toEqual({ role: 'user', content: 'Hello' });
    });
  });

  // ── CronJobScheduler ────────────────────────────────

  describe('CronJobScheduler 调度器', () => {
    afterEach(() => {
      CronJobScheduler.resetInstance(true);
    });

    test('应该返回单例实例', () => {
      const instance1 = CronJobScheduler.getInstance();
      const instance2 = CronJobScheduler.getInstance();
      expect(instance1).toBe(instance2);
    });

    test('resetInstance 应重置单例', () => {
      const instance1 = CronJobScheduler.getInstance();
      CronJobScheduler.resetInstance();
      const instance2 = CronJobScheduler.getInstance();
      expect(instance1).not.toBe(instance2);
    });

    test('应该注册任务', () => {
      const scheduler = CronJobScheduler.getInstance();
      scheduler.register({
        id: 'test-job-1',
        name: 'Test Job',
        schedule: 'every:5m',
        command: 'echo hello',
        enabled: true,
      });

      const jobs = scheduler.getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('Test Job');
    });

    test('应该获取单个任务', () => {
      const scheduler = CronJobScheduler.getInstance();
      scheduler.register({
        id: 'test-job-2',
        name: 'Test Job 2',
        schedule: 'every:1h',
        command: 'echo world',
        enabled: true,
      });

      const job = scheduler.getJob('test-job-2');
      expect(job).toBeDefined();
      expect(job!.name).toBe('Test Job 2');
    });

    test('应该移除任务', () => {
      const scheduler = CronJobScheduler.getInstance();
      scheduler.register({
        id: 'test-job-3',
        name: 'Test Job 3',
        schedule: 'every:1d',
        command: 'echo bye',
        enabled: true,
      });

      scheduler.unregister('test-job-3');
      expect(scheduler.getJob('test-job-3')).toBeUndefined();
    });

    test('应该启动和停止', () => {
      const scheduler = CronJobScheduler.getInstance();
      scheduler.start();
      scheduler.stop();
    });

    test('注入扫描应拦截危险命令', () => {
      const scheduler = CronJobScheduler.getInstance();
      scheduler.register({
        id: 'dangerous-job',
        name: 'Dangerous',
        schedule: 'every:5m',
        command: 'rm -rf /',
        enabled: true,
      });

      const job = scheduler.getJob('dangerous-job');
      expect(job).toBeDefined();
    });
  });

  // ── SkillRegistry ───────────────────────────────────

  describe('SkillRegistry 技能注册中心', () => {
    let registry: SkillRegistry;

    beforeEach(() => {
      SkillRegistry.resetInstance();
      registry = SkillRegistry.getInstance();
    });

    afterEach(() => {
      SkillRegistry.resetInstance();
    });

    test('应该返回单例实例', () => {
      const instance1 = SkillRegistry.getInstance();
      const instance2 = SkillRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });

    test('应该注册技能', () => {
      registry.register({
        definition: {
          name: 'test_skill',
          description: 'A test skill',
          category: 'test',
          parameters: [],
          version: '1.0.0',
        },
        execute: async () => ({ success: true, output: 'ok' }),
        validate: async () => ({ valid: true, errors: [] }),
      });

      expect(registry.getSkillCount()).toBe(1);
      expect(registry.hasSkill('test_skill')).toBe(true);
    });

    test('应该执行技能', async () => {
      registry.register({
        definition: {
          name: 'exec_skill',
          description: 'An executable skill',
          category: 'test',
          parameters: [
            {
              name: 'input',
              type: 'string',
              required: true,
              description: 'input',
            },
          ],
          version: '1.0.0',
        },
        execute: async (params) => ({
          success: true,
          output: `Result: ${params.input}`,
        }),
        validate: async (params) => ({
          valid: !!params.input,
          errors: params.input ? [] : ['input required'],
        }),
      });

      const result = await registry.executeSkill('exec_skill', {
        input: 'hello',
      });
      expect(result.success).toBe(true);
      expect(result.output).toBe('Result: hello');
    });

    test('应该发现技能', () => {
      registry.register({
        definition: {
          name: 'code_review',
          description: 'Review code quality and suggest improvements',
          category: 'development',
          parameters: [],
          version: '1.0.0',
          tags: ['code', 'review', 'quality'],
        },
        execute: async () => ({ success: true }),
        validate: async () => ({ valid: true, errors: [] }),
      });

      const matches = registry.discoverSkills('代码审查', 3);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0].skill.definition.name).toBe('code_review');
    });

    test('应该导出技能', () => {
      registry.register({
        definition: {
          name: 'exportable_skill',
          description: 'Can be exported',
          category: 'test',
          parameters: [],
          version: '1.0.0',
          source: 'user',
        },
        execute: async () => ({ success: true }),
        validate: async () => ({ valid: true, errors: [] }),
      });

      const exported = registry.exportSkill('exportable_skill');
      expect(exported).not.toBeNull();
      const parsed = JSON.parse(exported!);
      expect(parsed.definition.name).toBe('exportable_skill');
      expect(parsed.formatVersion).toBe('1.0.0');
    });

    test('应该导入技能', () => {
      const jsonStr = JSON.stringify({
        formatVersion: '1.0.0',
        agentskillsIo: { version: '1.0.0', schema: 'test' },
        definition: {
          name: 'imported_skill',
          description: 'An imported skill',
          category: 'test',
          parameters: [],
          version: '1.0.0',
        },
        exportedAt: new Date().toISOString(),
        exportedFrom: 'test',
      });

      const result = registry.importSkill(jsonStr);
      expect(result).toBe(true);
      expect(registry.hasSkill('imported_skill')).toBe(true);
    });

    test('应该转换为 OpenAI 工具格式', () => {
      registry.register({
        definition: {
          name: 'openai_skill',
          description: 'OpenAI format skill',
          category: 'test',
          parameters: [
            {
              name: 'query',
              type: 'string',
              required: true,
              description: 'query',
            },
          ],
          version: '1.0.0',
        },
        execute: async () => ({ success: true }),
        validate: async () => ({ valid: true, errors: [] }),
      });

      const tools = registry.toOpenAITools();
      expect(tools.length).toBeGreaterThanOrEqual(1);
      const tool = tools.find(
        (t) => (t.function as Record<string, unknown>).name === 'openai_skill'
      );
      expect(tool).toBeDefined();
    });

    test('应该注销技能', () => {
      registry.register({
        definition: {
          name: 'removable_skill',
          description: 'Can be removed',
          category: 'test',
          parameters: [],
          version: '1.0.0',
        },
        execute: async () => ({ success: true }),
        validate: async () => ({ valid: true, errors: [] }),
      });

      expect(registry.hasSkill('removable_skill')).toBe(true);
      registry.unregister('removable_skill');
      expect(registry.hasSkill('removable_skill')).toBe(false);
    });

    test('应该获取技能元数据', () => {
      registry.register({
        definition: {
          name: 'meta_skill',
          description: 'Metadata skill',
          category: 'test',
          parameters: [
            {
              name: 'x',
              type: 'string',
              required: false,
              description: 'x param',
            },
          ],
          version: '2.0.0',
          author: 'test',
          tags: ['meta'],
        },
        execute: async () => ({ success: true }),
        validate: async () => ({ valid: true, errors: [] }),
      });

      const metas = registry.getAllSkillMeta();
      const meta = metas.find((m) => m.name === 'meta_skill');
      expect(meta).toBeDefined();
      expect(meta!.version).toBe('2.0.0');
      expect(meta!.tags).toContain('meta');
    });
  });

  // ── 调用链路: AgentHarness → SessionStore/Cron/Skill ──

  describe('调用链路: AgentHarness → SessionStore/Cron/Skill', () => {
    test('AgentHarness 初始化应创建 Phase 3 实例', async () => {
      CronJobScheduler.resetInstance();
      SkillRegistry.resetInstance();

      const harness = new AgentHarness();
      await harness.initialize();

      expect(harness.getSessionStore()).not.toBeNull();
      expect(harness.getCronScheduler()).not.toBeNull();
      expect(harness.getSkillRegistry()).not.toBeNull();

      const sessionStore = harness.getSessionStore()!;
      expect(sessionStore.getStats()).toBeDefined();

      const cronScheduler = harness.getCronScheduler()!;
      expect(cronScheduler.getJobs()).toBeDefined();

      const skillRegistry = harness.getSkillRegistry()!;
      expect(skillRegistry.getSkillCount()).toBeDefined();

      await harness.shutdown();
    });

    test('shutdown 应清理 Phase 3 资源', async () => {
      CronJobScheduler.resetInstance();
      SkillRegistry.resetInstance();

      const harness = new AgentHarness();
      await harness.initialize();

      expect(harness.getSessionStore()).not.toBeNull();
      expect(harness.getCronScheduler()).not.toBeNull();

      await harness.shutdown();

      expect(harness.getSessionStore()).toBeNull();
      expect(harness.getCronScheduler()).toBeNull();
      expect(harness.getSkillRegistry()).toBeNull();
    });

    test('会话存储应支持完整的会话生命周期', async () => {
      CronJobScheduler.resetInstance();
      SkillRegistry.resetInstance();

      const harness = new AgentHarness();
      await harness.initialize();

      const sessionStore = harness.getSessionStore()!;
      const sessionId = `lifecycle-${Date.now()}`;

      sessionStore.createSession({
        id: sessionId,
        source: 'integration-test',
        userId: 'tester',
        model: 'test-model',
      });

      sessionStore.appendMessage({
        sessionId,
        role: 'user',
        content: 'Hello from integration test',
      });
      sessionStore.appendMessage({
        sessionId,
        role: 'assistant',
        content: 'Integration test response',
        tokenCount: 50,
      });

      sessionStore.updateSessionTokens(sessionId, 100, 50, 0.001);
      sessionStore.setSessionTitle(sessionId, 'Integration Test Session');
      sessionStore.endSession(sessionId, 'test-completed');

      const session = sessionStore.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.source).toBe('integration-test');
      expect(session!.messageCount).toBe(2);
      expect(session!.title).toBe('Integration Test Session');
      expect(session!.inputTokens).toBe(100);
      expect(session!.outputTokens).toBe(50);
      expect(session!.endReason).toBe('test-completed');

      const messages = sessionStore.getMessages(sessionId);
      expect(messages).toHaveLength(2);

      await harness.shutdown();
    });

    test('Cron调度器应支持任务注册和管理', async () => {
      CronJobScheduler.resetInstance();
      SkillRegistry.resetInstance();

      const harness = new AgentHarness();
      await harness.initialize();

      const cron = harness.getCronScheduler()!;
      const jobId = `integration-job-${Date.now()}`;

      cron.register({
        id: jobId,
        name: 'Integration Test Job',
        schedule: 'every:30m',
        command: 'echo integration-test',
        enabled: true,
      });

      const job = cron.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.name).toBe('Integration Test Job');
      expect(job!.schedule).toBe('every:30m');

      cron.unregister(jobId);
      expect(cron.getJob(jobId)).toBeUndefined();

      await harness.shutdown();
    });

    test('Skill注册中心应支持技能注册和发现', async () => {
      CronJobScheduler.resetInstance();
      SkillRegistry.resetInstance();

      const harness = new AgentHarness();
      await harness.initialize();

      const skillReg = harness.getSkillRegistry()!;
      skillReg.register({
        definition: {
          name: 'integration_test_skill',
          description: 'Integration test skill for code analysis',
          category: 'development',
          parameters: [
            {
              name: 'code',
              type: 'string',
              required: true,
              description: 'Code to analyze',
            },
          ],
          version: '1.0.0',
          tags: ['code', 'analysis', 'test'],
        },
        execute: async (params: Record<string, unknown>) => ({
          success: true,
          output: `Analyzed: ${params.code}`,
        }),
        validate: async (params: Record<string, unknown>) => ({
          valid: !!params.code,
          errors: params.code ? [] : ['code is required'],
        }),
      });

      expect(skillReg.hasSkill('integration_test_skill')).toBe(true);

      const matches = skillReg.discoverSkills('代码分析', 3);
      expect(matches.length).toBeGreaterThanOrEqual(1);

      const result = await skillReg.executeSkill('integration_test_skill', {
        code: 'console.log("hello")',
      });
      expect(result.success).toBe(true);

      await harness.shutdown();
    });
  });
});
