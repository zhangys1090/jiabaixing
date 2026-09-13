"use strict";
/**
 * 批处理路由 - POST /api/batch/run
 *
 * 并行运行多个 prompt，生成结构化轨迹数据（ShareGPT / JSONL / raw）
 * 接入 BatchProcessor 引擎，复用 core.processInput 作为单条执行器
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBatchRoutes = registerBatchRoutes;
const express_1 = __importDefault(require("express"));
const BatchProcessor_1 = require("../../harness/batch/BatchProcessor");
const Logger_1 = require("../../utils/Logger");
function registerBatchRoutes(app, core) {
    app.post('/api/batch/run', express_1.default.json({ limit: '50mb' }), async (req, res) => {
        try {
            if (!core) {
                res.status(503).json({ success: false, error: '核心未初始化' });
                return;
            }
            const body = req.body;
            if (!Array.isArray(body?.prompts) || body.prompts.length === 0) {
                res
                    .status(400)
                    .json({ success: false, error: '请提供非空 prompts 数组' });
                return;
            }
            if (body.prompts.length > 100) {
                res
                    .status(400)
                    .json({ success: false, error: '单次批处理最多100条prompt' });
                return;
            }
            for (const p of body.prompts) {
                if (!p.text ||
                    typeof p.text !== 'string' ||
                    p.text.trim().length === 0) {
                    res.status(400).json({
                        success: false,
                        error: '每条prompt必须包含非空text字段',
                    });
                    return;
                }
                if (p.text.length > 50000) {
                    res
                        .status(400)
                        .json({ success: false, error: '单条prompt不能超过50000字' });
                    return;
                }
            }
            const config = {
                concurrency: Math.min(body.config?.concurrency ?? 3, 10),
                timeout: body.config?.timeout ?? 60000,
                outputFormat: body.outputFormat ?? body.config?.outputFormat ?? 'raw',
                continueOnError: body.config?.continueOnError ?? true,
            };
            const processor = new BatchProcessor_1.BatchProcessor(config);
            const results = await processor.run(body.prompts, async (prompt) => {
                const start = Date.now();
                try {
                    const result = await core.processInput(prompt.text, undefined, undefined);
                    return {
                        id: prompt.id,
                        response: result.response,
                        success: true,
                        duration: Date.now() - start,
                        metadata: {
                            ...prompt.metadata,
                            traceId: result.traceId,
                            quality: result.quality,
                        },
                    };
                }
                catch (err) {
                    return {
                        id: prompt.id,
                        response: '',
                        success: false,
                        duration: Date.now() - start,
                        error: err.message,
                        metadata: prompt.metadata,
                    };
                }
            });
            const format = config.outputFormat;
            if (format === 'sharegpt') {
                res.json({
                    success: true,
                    format,
                    data: processor.toShareGPT(results),
                });
            }
            else if (format === 'jsonl') {
                res.type('text/plain').send(processor.toJSONL(results));
            }
            else {
                res.json({ success: true, format: 'raw', data: results });
            }
            Logger_1.Logger.info(`批处理完成: ${results.filter((r) => r.success).length}/${results.length} 成功`, 'BatchRoutes');
        }
        catch (error) {
            Logger_1.Logger.error('批处理路由失败', error, 'BatchRoutes');
            res
                .status(500)
                .json({ success: false, error: error.message });
        }
    });
}
