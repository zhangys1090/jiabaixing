"use strict";
/**
 * 批处理引擎
 *
 * 并行运行多个 prompt，生成结构化轨迹数据
 * 设计参考: Hermes Agent 批处理系统
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchProcessor = void 0;
const Logger_1 = require("../../utils/Logger");
class BatchProcessor {
    config;
    constructor(config) {
        this.config = {
            concurrency: config.concurrency || 3,
            timeout: config.timeout || 30000,
            outputFormat: config.outputFormat || 'sharegpt',
            continueOnError: config.continueOnError ?? true,
        };
    }
    /**
     * 并行运行批处理
     * @param prompts - 待处理的 prompt 列表
     * @param executor - 单个 prompt 的执行函数
     * @returns 所有 prompt 的执行结果
     */
    async run(prompts, executor) {
        if (!Array.isArray(prompts) || prompts.length === 0) {
            return [];
        }
        const results = [];
        const queue = [...prompts];
        let running = 0;
        Logger_1.Logger.info(`批处理启动: ${prompts.length} 个任务, 并发数 ${this.config.concurrency}`, 'BatchProcessor');
        return new Promise((resolve) => {
            const tryNext = () => {
                if (queue.length === 0 && running === 0) {
                    const successCount = results.filter((r) => r.success).length;
                    Logger_1.Logger.info(`批处理完成: ${successCount}/${results.length} 成功`, 'BatchProcessor');
                    resolve(results);
                    return;
                }
                while (running < this.config.concurrency && queue.length > 0) {
                    const prompt = queue.shift();
                    running++;
                    // 带超时的执行，超时后清理定时器
                    let timeoutId;
                    const timeoutPromise = new Promise((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('执行超时')), this.config.timeout);
                    });
                    const executeWithTimeout = Promise.race([
                        executor(prompt).finally(() => {
                            if (timeoutId !== undefined)
                                clearTimeout(timeoutId);
                        }),
                        timeoutPromise,
                    ]);
                    executeWithTimeout
                        .then((result) => {
                        results.push(result);
                    })
                        .catch((err) => {
                        if (timeoutId !== undefined)
                            clearTimeout(timeoutId);
                        const errorMessage = err.message;
                        Logger_1.Logger.warn(`任务 ${prompt.id} 失败: ${errorMessage}`, 'BatchProcessor');
                        results.push({
                            id: prompt.id,
                            response: '',
                            success: false,
                            duration: 0,
                            error: errorMessage,
                        });
                    })
                        .finally(() => {
                        running--;
                        tryNext();
                    });
                }
            };
            tryNext();
        });
    }
    /**
     * 转换为 ShareGPT 格式
     * @param results - 批处理结果列表
     * @returns ShareGPT 对话格式数据
     */
    toShareGPT(results) {
        return {
            conversations: results.flatMap((r) => [
                { from: 'human', value: r.id },
                { from: 'gpt', value: r.response },
            ]),
        };
    }
    /**
     * 转换为 JSONL 格式
     * @param results - 批处理结果列表
     * @returns JSONL 格式字符串
     */
    toJSONL(results) {
        return results
            .map((r) => JSON.stringify({ id: r.id, response: r.response, success: r.success }))
            .join('\n');
    }
    /**
     * 获取配置
     * @returns 只读的完整配置
     */
    getConfig() {
        return { ...this.config };
    }
}
exports.BatchProcessor = BatchProcessor;
