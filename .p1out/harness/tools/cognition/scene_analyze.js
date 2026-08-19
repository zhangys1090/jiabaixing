"use strict";
/**
 * Harness Tool: analyze_scene - 判断对话场景类型
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCENE_ANALYZE_DEF = void 0;
exports.createSceneAnalyzeExecutor = createSceneAnalyzeExecutor;
const types_1 = require("../../types");
exports.SCENE_ANALYZE_DEF = {
    name: 'analyze_scene',
    description: '判断当前对话的场景类型（工作/日常/情感/紧急等）。适用场景：你不确定如何调整语气、或用户突然转换话题时。不适用：场景已经明确时。',
    category: types_1.ToolCategory.COGNITION,
    parameters: {
        text: {
            type: 'string',
            description: '用户最近的输入文本',
        },
    },
    requiredParams: ['text'],
    requiredPermissions: [],
    riskLevel: 'low',
    idempotent: true,
    timeout: 5000,
};
/** 创建 analyze_scene 执行器 */
function createSceneAnalyzeExecutor(deps) {
    return async (params, _context) => {
        const text = String(params.text || '');
        const scene = await deps.recognizeScene(text);
        return {
            success: true,
            output: JSON.stringify({ type: scene.type, context: scene.context }),
            duration: 0,
            validated: false,
        };
    };
}
