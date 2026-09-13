"use strict";
/**
 * ToolChannel —— harness 工具通道适配器
 *
 * 将 ToolRegistry.execute(...) 归一为 ActionChannel 契约。
 * 编排层经 ActionDispatcher 以 channel='tool' 调度任意已注册工具。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolChannel = void 0;
const Logger_1 = require("../../../utils/Logger");
class ToolChannel {
    registry;
    kind = 'tool';
    constructor(registry) {
        this.registry = registry;
    }
    async dispatch(request) {
        const start = Date.now();
        const tool = request.tool;
        if (!tool) {
            return {
                channel: 'tool',
                success: false,
                output: null,
                error: 'ToolChannel 需要 request.tool',
                durationMs: Date.now() - start,
            };
        }
        try {
            const result = await this.registry.execute(tool, request.params ?? {}, (request.context ?? {}));
            return {
                channel: 'tool',
                success: result.success,
                output: result.output,
                error: result.error,
                durationMs: result.duration ?? Date.now() - start,
                raw: result,
                metadata: result.metadata,
            };
        }
        catch (err) {
            Logger_1.Logger.error(`ToolChannel 调度失败: ${tool}`, err, 'ToolChannel');
            return {
                channel: 'tool',
                success: false,
                output: null,
                error: err.message,
                durationMs: Date.now() - start,
            };
        }
    }
}
exports.ToolChannel = ToolChannel;
