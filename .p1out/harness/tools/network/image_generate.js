"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMAGE_GENERATE_DEF = void 0;
exports.createImageGenerateExecutor = createImageGenerateExecutor;
const Logger_1 = require("../../../utils/Logger");
const types_1 = require("../../types");
exports.IMAGE_GENERATE_DEF = {
    name: 'image_generate',
    description: '图像生成工具。根据文本描述生成图像。适用场景：生成插图、设计原型、创意图片。支持多种尺寸、风格、负面提示和种子控制。',
    category: types_1.ToolCategory.NETWORK,
    parameters: {
        prompt: {
            type: 'string',
            description: '图像描述（英文效果最佳）',
        },
        size: {
            type: 'string',
            description: '图像尺寸',
            enum: [
                'square_hd',
                'square',
                'portrait_4_3',
                'portrait_16_9',
                'landscape_4_3',
                'landscape_16_9',
            ],
            default: 'square',
        },
        style: {
            type: 'string',
            description: '艺术风格提示（可选）',
        },
        negative_prompt: {
            type: 'string',
            description: '负面提示词，指定不想在图像中出现的内容，如"blurry, text, watermark"',
        },
        seed: {
            type: 'number',
            description: '随机种子，用于可复现生成。相同seed+prompt生成相同图像',
        },
        num_images: {
            type: 'number',
            description: '生成图像数量（1-4），默认1',
            default: 1,
        },
    },
    requiredParams: ['prompt'],
    requiredPermissions: [types_1.Permission.NETWORK_ACCESS],
    riskLevel: 'low',
    idempotent: false,
    timeout: 60000,
};
function ok(output, duration, metadata) {
    return { success: true, output, duration, validated: false, metadata };
}
function fail(error, duration, output = '') {
    return { success: false, output, error, duration, validated: false };
}
const UNSAFE_PROMPT_PATTERNS = [
    /nude|naked|nsfw|porn|erotic|sexual/i,
    /violence|gore|blood|kill|murder|weapon|gun/i,
    /hate|racist|nazi|swastika/i,
    /child\s*(abuse|porn|exploit)/i,
    /self[\s-]?harm|suicide|cutting/i,
];

function filterPromptSafety(prompt) {
    for (const pattern of UNSAFE_PROMPT_PATTERNS) {
        if (pattern.test(prompt)) {
            return { safe: false, reason: `提示词包含不安全内容，匹配规则: ${pattern.source}` };
        }
    }
    return { safe: true, reason: null };
}

function createImageGenerateExecutor(deps = {}) {
    return async (params, _context) => {
        const startTime = Date.now();
        const prompt = params.prompt;
        const size = params.size || 'square';
        const style = params.style;
        const negativePrompt = params.negative_prompt;
        const seed = params.seed;
        const numImages = Math.min(4, Math.max(1, Number(params.num_images) || 1));
        try {
            if (!prompt || prompt.trim().length === 0) {
                return fail('图像描述不能为空', Date.now() - startTime);
            }
            const safetyCheck = filterPromptSafety(prompt);
            if (!safetyCheck.safe) {
                Logger_1.Logger.warn(`🎨 image_generate 安全拦截: ${safetyCheck.reason}`, 'ImageGenerate');
                return fail(`图像生成被安全策略拦截: ${safetyCheck.reason}`, Date.now() - startTime);
            }
            if (negativePrompt) {
                const negSafetyCheck = filterPromptSafety(negativePrompt);
                if (!negSafetyCheck.safe) {
                    Logger_1.Logger.warn(`🎨 image_generate negative_prompt安全拦截: ${negSafetyCheck.reason}`, 'ImageGenerate');
                    return fail(`负面提示词被安全策略拦截: ${negSafetyCheck.reason}`, Date.now() - startTime);
                }
            }
            const fullPrompt = style ? `${prompt}, ${style} style` : prompt;
            const encodedPrompt = encodeURIComponent(fullPrompt);
            if (deps.imageApiClient) {
                const result = await deps.imageApiClient.generate(fullPrompt, size, {
                    negativePrompt,
                    seed,
                    numImages,
                });
                return ok(`图像已生成: ${result.url}`, Date.now() - startTime, {
                    url: result.url,
                    base64: result.base64,
                    prompt: fullPrompt,
                    size,
                    negativePrompt,
                    seed,
                });
            }
            const imageApiBaseUrl = process.env.TRAE_IMAGE_API_URL || 'https://trae-api-cn.mchost.guru';
            let urlParams = `prompt=${encodedPrompt}&image_size=${size}`;
            if (negativePrompt) urlParams += `&negative_prompt=${encodeURIComponent(negativePrompt)}`;
            if (seed !== undefined) urlParams += `&seed=${seed}`;
            if (numImages > 1) urlParams += `&num_images=${numImages}`;
            const imageUrl = `${imageApiBaseUrl}/api/ide/v1/text_to_image?${urlParams}`;
            let response;
            let lastError = null;
            const maxRetries = 2;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    response = await fetch(imageUrl, {
                        signal: AbortSignal.timeout(55000),
                    });
                    break;
                }
                catch (fetchErr) {
                    lastError = fetchErr;
                    if (attempt < maxRetries) {
                        Logger_1.Logger.info(`🎨 image_generate 重试 (${attempt + 1}/${maxRetries}): "${prompt}"`, 'ImageGenerate');
                        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                    }
                }
            }
            if (!response) {
                return fail(`图像生成失败: ${lastError?.message || '网络错误'}`, Date.now() - startTime);
            }
            if (!response.ok) {
                return fail(`图像生成失败: HTTP ${response.status}`, Date.now() - startTime);
            }
            const contentType = response.headers.get('content-type') || '';
            if (contentType.startsWith('image/')) {
                const buffer = Buffer.from(await response.arrayBuffer());
                const base64 = buffer.toString('base64');
                const dataUrl = `data:${contentType};base64,${base64}`;
                Logger_1.Logger.info(`🎨 image_generate 成功: "${prompt}" (${size})`, 'ImageGenerate');
                return ok(`图像已生成 (${size}, ${buffer.length} bytes)`, Date.now() - startTime, {
                    imageUrl,
                    base64: dataUrl,
                    prompt: fullPrompt,
                    size,
                    negativePrompt,
                    seed,
                    contentLength: buffer.length,
                });
            }
            const json = (await response.json());
            const url = (json.url || json.image_url || json.data);
            if (url) {
                Logger_1.Logger.info(`🎨 image_generate 成功: "${prompt}" → ${url}`, 'ImageGenerate');
                return ok(`图像已生成: ${url}`, Date.now() - startTime, {
                    url,
                    prompt: fullPrompt,
                    size,
                    negativePrompt,
                    seed,
                });
            }
            return fail('图像生成服务返回了无法解析的响应', Date.now() - startTime);
        }
        catch (error) {
            Logger_1.Logger.error('❌ image_generate 失败', error, 'ImageGenerate');
            return fail(`图像生成失败: ${error.message}`, Date.now() - startTime);
        }
    };
}
