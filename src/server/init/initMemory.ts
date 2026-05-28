import { MemoryEngine } from '../../memory/MemoryEngine';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import type { DataSovereigntyPipeline } from '../../security/DataSovereigntyPipeline';

export interface MemoryInitResult {
  memoryEngine: MemoryEngine;
}

export async function initMemory(
  core: JiabaixingCore,
  sovereigntyPipeline: DataSovereigntyPipeline
): Promise<MemoryInitResult> {
  const memoryEngine = new MemoryEngine();
  await memoryEngine.initialize();

  core.setMemoryEngine(memoryEngine);

  const { UnifiedContextPipeline } =
    await import('../../core/UnifiedContextPipeline');
  const contextPipeline = new UnifiedContextPipeline();
  contextPipeline.setMemoryEngine(memoryEngine);
  contextPipeline.setSovereigntyPipeline(sovereigntyPipeline);

  return { memoryEngine };
}
