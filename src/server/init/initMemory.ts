import { MemoryAuthority } from '../../authority/MemoryAuthority';
import { MemoryAuthorityGuard } from '../../authority/MemoryAuthorityGuard';
import { MemoryEngine } from '../../memory/MemoryEngine';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import type { DataSovereigntyPipeline } from '../../security/DataSovereigntyPipeline';
import { Logger } from '../../utils/Logger';

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

  const memoryAuthority = MemoryAuthority.getInstance();
  memoryAuthority.registerLocalFallback({
    storeShortTermMemory: (content, scene, emotion) =>
      memoryEngine.storeShortTermMemory(content, scene, emotion),
    storeLongTermMemory: (content, scene, emotion) =>
      memoryEngine.storeLongTermMemory(content, scene, emotion),
    storeInstantMemory: (content, scene, emotion) =>
      memoryEngine.storeInstantMemory(content, scene, emotion),
    storeFeedbackSignal: (data) =>
      memoryEngine.storeFeedbackSignal(data),
    preciseHybridRetrieval: (query, scene, emotion, topK) =>
      memoryEngine.preciseHybridRetrieval(query, scene, emotion, topK),
  });
  Logger.info('MemoryAuthority: local fallback (TS MemoryEngine) registered from initMemory', 'InitMemory');

  const { UnifiedContextPipeline } =
    await import('../../core/UnifiedContextPipeline');
  const contextPipeline = new UnifiedContextPipeline();
  contextPipeline.setMemoryEngine(memoryEngine);
  contextPipeline.setSovereigntyPipeline(sovereigntyPipeline);

  return { memoryEngine };
}
