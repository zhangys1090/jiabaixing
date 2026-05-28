import { EmojiManager } from '../../interaction/EmojiManager';
import { InteractionEngine } from '../../interaction/InteractionEngine';
import { EmotionAnalyzer } from '../../multimodal/EmotionAnalyzer';
import { EnvironmentPerceptionEngine } from '../../multimodal/EnvironmentPerceptionEngine';
import { SceneRecognizer } from '../../multimodal/SceneRecognizer';
import type { JiabaixingCore } from '../../core/JiabaixingCore';

export interface InteractionInitResult {
  sceneRecognizer: SceneRecognizer;
}

export async function initInteraction(
  core: JiabaixingCore
): Promise<InteractionInitResult> {
  const emojiManager = new EmojiManager();
  await emojiManager.initialize();

  const interactionEngine = new InteractionEngine();
  await interactionEngine.initialize();
  interactionEngine.setCore(core);

  const emotionAnalyzer = new EmotionAnalyzer();
  const sceneRecognizer = new SceneRecognizer();
  new EnvironmentPerceptionEngine(emotionAnalyzer, sceneRecognizer);

  return { sceneRecognizer };
}
