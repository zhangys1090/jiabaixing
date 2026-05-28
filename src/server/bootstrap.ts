import { JiabaixingCore } from '../core/JiabaixingCore';
import { ScenarioAwareScheduler } from '../core/ScenarioAwareScheduler';
import { Logger } from '../utils/Logger';
import { initSecurity } from './init/initSecurity';
import { initMemory } from './init/initMemory';
import { initInteraction } from './init/initInteraction';
import { initEvolution } from './init/initEvolution';
import { initHarness } from './init/initHarness';
import { initGateway } from './init/initGateway';

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
    const { sovereigntyPipeline } = await initSecurity();
    console.log('✅');

    process.stdout.write('  💾 数据库... ');
    const { memoryEngine } = await initMemory(core, sovereigntyPipeline);
    console.log('✅');

    process.stdout.write('  🎭 交互模块... ');
    const { sceneRecognizer } = await initInteraction(core);
    console.log('✅');

    process.stdout.write('  🔧 技能系统... ');
    console.log('✅ (内置)');

    process.stdout.write('  🧠 推理引擎... ');
    console.log('✅');

    process.stdout.write('  🧬 核心初始化... ');
    await core.initialize();
    console.log('✅');

    process.stdout.write('  📡 调度器... ');
    const scenarioScheduler = new ScenarioAwareScheduler();
    scenarioScheduler.setMemoryEngine(memoryEngine);

    core.setScenarioScheduler(scenarioScheduler);

    scenarioScheduler.start();

    const { setSchedulerInstance } = await import('../routes/automation');
    setSchedulerInstance(scenarioScheduler);

    console.log('✅');

    process.stdout.write('  🧬 进化引擎... ');
    await initEvolution(core, memoryEngine);
    console.log('✅');

    process.stdout.write('  🏗️ Harness 框架... ');
    const { harness } = await initHarness(core, memoryEngine, sceneRecognizer);
    console.log('✅');

    process.stdout.write('  📡 网关隔离... ');
    await initGateway(core, harness);
    console.log('✅');

    console.log('\n  ✅ 系统就绪\n');
    Logger.info('系统初始化完成', 'Bootstrap');

    return core;
  } catch (error) {
    console.log('❌');
    Logger.error('❌ 初始化失败', error as Error, 'Bootstrap');
    process.exit(1);
  }
}
