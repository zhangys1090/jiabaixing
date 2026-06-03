/**
 * 诊断 Harness 初始化问题
 * 运行: npx ts-node --transpile-only scripts/diagnose-harness.ts
 */

import 'dotenv/config';

async function diagnose() {
  console.log('=== Harness 初始化诊断 ===\n');

  // 1. 检查环境变量
  console.log('1. 环境变量检查:');
  console.log(`   LLM_MODEL: ${process.env.LLM_MODEL || '未设置'}`);
  console.log(`   OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '***已设置***' : '未设置'}`);
  console.log(`   XIAOMI_API_KEY: ${process.env.XIAOMI_API_KEY ? '***已设置***' : '未设置'}`);
  console.log(`   HARNESS_LOOP: ${process.env.HARNESS_LOOP || '未设置(默认true)'}`);
  console.log();

  // 2. 检查依赖模块
  console.log('2. 依赖模块检查:');
  try {
    await import('../src/harness/AgentHarness');
    console.log('   AgentHarness: ✅');
  } catch (e) {
    console.log(`   AgentHarness: ❌ ${(e as Error).message}`);
  }

  try {
    await import('../src/harness/tools/registerHarnessTools');
    console.log('   registerHarnessTools: ✅');
  } catch (e) {
    console.log(`   registerHarnessTools: ❌ ${(e as Error).message}`);
  }

  try {
    await import('../src/harness/persistence/PersistenceService');
    console.log('   PersistenceService: ✅');
  } catch (e) {
    console.log(`   PersistenceService: ❌ ${(e as Error).message}`);
  }

  try {
    await import('../src/harness/persistence/TrajectoryDatabase');
    console.log('   TrajectoryDatabase: ✅');
  } catch (e) {
    console.log(`   TrajectoryDatabase: ❌ ${(e as Error).message}`);
  }

  try {
    const betterSqlite = await import('better-sqlite3');
    const db = new betterSqlite.default(':memory:');
    db.exec('CREATE TABLE test (id INTEGER)');
    db.close();
    console.log('   better-sqlite3: ✅');
  } catch (e) {
    console.log(`   better-sqlite3: ❌ ${(e as Error).message}`);
  }
  console.log();

  // 3. 检查 Core 初始化
  console.log('3. Core 初始化检查:');
  try {
    const { JiabaixingCore } = await import('../src/core/JiabaixingCore');
    const core = new JiabaixingCore();
    console.log('   Core 创建: ✅');

    await core.initialize();
    console.log('   Core 初始化: ✅');
    console.log(`   Harness (init前): ${core.getHarness() ? 'EXISTS' : 'NULL'}`);
  } catch (e) {
    console.log(`   Core 初始化: ❌ ${(e as Error).message}`);
    console.log(`   堆栈: ${(e as Error).stack?.split('\n').slice(0, 3).join('\n')}`);
  }
  console.log();

  // 4. 检查 AgentHarness 独立初始化
  console.log('4. AgentHarness 独立初始化检查:');
  try {
    const { AgentHarness } = await import('../src/harness/AgentHarness');
    const harness = new AgentHarness({
      useHarnessLoop: true,
      useHarnessTools: true,
      useHarnessContext: true,
      useHarnessVerification: true,
      useHarnessConstraints: true,
      useHarnessPersistence: true,
      useTrajectoryPersistence: true,
      useIndependentEvaluator: true,
    });
    console.log(`   创建: ✅ (config: ${JSON.stringify(harness.getConfig())})`);

    harness.setDeps({
      llm: { chatWithTools: async () => ({ content: 'ok' }), chat: async () => 'ok' },
      constitutionalBuilder: { buildConstitutionPrompt: async () => 'test' },
      memoryInjector: { autoRetrieveMemories: async () => [] },
      memoryStore: { storeConversation: async () => {} },
      dynamicContext: { getDynamicContext: () => '' },
      historyProvider: { getRecentHistory: () => [], getAllHistory: () => [] },
      personaCore: {
        buildPersonaSummary: () => '',
        buildSceneToneInstruction: () => '',
        getToneForScene: () => ({
          temperature: 0.5, formality: 0.5, verbosity: 0.5,
          emojiFrequency: 0, proactive: false,
        }),
      },
      evolutionExamples: { getPromptExamples: () => [] },
      environmentSensor: { getEnvironmentContext: () => '' },
    });
    console.log('   setDeps: ✅');

    await harness.initialize();
    console.log('   initialize: ✅');
  } catch (e) {
    console.log(`   initialize: ❌ ${(e as Error).message}`);
    console.log(`   堆栈: ${(e as Error).stack?.split('\n').slice(0, 5).join('\n')}`);
  }

  console.log('\n=== 诊断完成 ===');
  process.exit(0);
}

diagnose().catch((e) => {
  console.error('诊断脚本失败:', e);
  process.exit(1);
});
