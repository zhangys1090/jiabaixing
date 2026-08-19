"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initInteraction = initInteraction;
const EmojiManager_1 = require("../../interaction/EmojiManager");
const InteractionEngine_1 = require("../../interaction/InteractionEngine");
const EmotionAnalyzer_1 = require("../../multimodal/EmotionAnalyzer");
const EnvironmentPerceptionEngine_1 = require("../../multimodal/EnvironmentPerceptionEngine");
const SceneRecognizer_1 = require("../../multimodal/SceneRecognizer");
async function initInteraction(core, memoryEngine) {
    const emojiManager = new EmojiManager_1.EmojiManager();
    await emojiManager.initialize();
    const interactionEngine = new InteractionEngine_1.InteractionEngine();
    await interactionEngine.initialize();
    interactionEngine.setCore(core);
    if (memoryEngine) {
        interactionEngine.setMemoryEngine(memoryEngine);
    }
    const emotionAnalyzer = new EmotionAnalyzer_1.EmotionAnalyzer();
    const sceneRecognizer = new SceneRecognizer_1.SceneRecognizer();
    new EnvironmentPerceptionEngine_1.EnvironmentPerceptionEngine(emotionAnalyzer, sceneRecognizer);
    return { sceneRecognizer };
}
