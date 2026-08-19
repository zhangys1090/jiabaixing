import type { IMemoryEngine } from '../../core/IMemoryEngine';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import { EmojiManager } from '../../interaction/EmojiManager';
import { InteractionEngine } from '../../interaction/InteractionEngine';
import { EmotionAnalyzer } from '../../multimodal/EmotionAnalyzer';
import { EnvironmentPerceptionEngine } from '../../multimodal/EnvironmentPerceptionEngine';
import { SceneRecognizer } from '../../multimodal/SceneRecognizer';

export interface InteractionInitResult {
  sceneRecognizer: SceneRecognizer;
}

export async function initInteraction(
  core: JiabaixingCore,
  memoryEngine?: IMemoryEngine
): Promise<InteractionInitResult> {
  const emojiManager = new EmojiManager();
  await emojiManager.initialize();

  const interactionEngine = new InteractionEngine();
  await interactionEngine.initialize();
  interactionEngine.setCore(core);

  if (memoryEngine) {
    interactionEngine.setMemoryEngine(memoryEngine);
  }

  const emotionAnalyzer = new EmotionAnalyzer();
  const sceneRecognizer = new SceneRecognizer();
  new EnvironmentPerceptionEngine(emotionAnalyzer, sceneRecognizer);

  return { sceneRecognizer };
}
