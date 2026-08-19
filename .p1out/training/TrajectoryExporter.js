"use strict";
/**
 * RL 训练轨迹导出器
 *
 * 从 Agent 会话中生成轨迹数据，用于强化学习和模型微调
 * 支持 ShareGPT / JSONL / OpenAI Fine-tuning 格式导出
 * 设计参考: Hermes Agent RL 训练数据生成
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrajectoryExporter = exports.ExportFormat = void 0;
/** 导出格式 */
var ExportFormat;
(function (ExportFormat) {
    ExportFormat["SHAREGPT"] = "sharegpt";
    ExportFormat["JSONL"] = "jsonl";
    ExportFormat["OPENAI_FINETUNE"] = "openai_finetune";
})(ExportFormat || (exports.ExportFormat = ExportFormat = {}));
class TrajectoryExporter {
    constructor(config) {
        this.config = {
            minQuality: config?.minQuality ?? 0.0,
            maxQuality: config?.maxQuality ?? 1.0,
            maxSteps: config?.maxSteps ?? 100,
        };
    }
    /**
     * 按质量分数过滤轨迹
     */
    filterByQuality(trajectories) {
        return trajectories.filter((t) => {
            return (t.quality >= this.config.minQuality &&
                t.quality <= this.config.maxQuality);
        });
    }
    /**
     * 导出为 ShareGPT 格式
     */
    toShareGPT(trajectories) {
        const filtered = this.filterByQuality(trajectories);
        return filtered.map((t) => ({
            conversations: t.steps
                .filter((s) => s.role === 'user' || s.role === 'assistant' || s.role === 'system')
                .map((s) => ({
                from: s.role === 'user'
                    ? 'human'
                    : s.role === 'system'
                        ? 'system'
                        : 'gpt',
                value: s.content,
            })),
        }));
    }
    /**
     * 导出为 JSONL 格式
     */
    toJSONL(trajectories) {
        const filtered = this.filterByQuality(trajectories);
        return filtered
            .map((t) => JSON.stringify({
            id: t.id,
            quality: t.quality,
            steps: t.steps.map((s) => ({ role: s.role, content: s.content })),
        }))
            .join('\n');
    }
    /**
     * 导出为 OpenAI Fine-tuning 格式
     */
    toOpenAIFineTune(trajectories) {
        const filtered = this.filterByQuality(trajectories);
        return filtered.map((t) => ({
            messages: t.steps
                .filter((s) => s.role === 'system' || s.role === 'user' || s.role === 'assistant')
                .map((s) => ({
                role: s.role,
                content: s.content,
            })),
        }));
    }
    /**
     * 通用导出方法
     */
    export(trajectories, format) {
        switch (format) {
            case ExportFormat.SHAREGPT:
                return this.toShareGPT(trajectories);
            case ExportFormat.JSONL:
                return this.toJSONL(trajectories);
            case ExportFormat.OPENAI_FINETUNE:
                return this.toOpenAIFineTune(trajectories);
            default:
                throw new Error(`不支持的导出格式: ${format}`);
        }
    }
    /**
     * 生成轨迹统计信息
     */
    getStats(trajectories) {
        const filtered = this.filterByQuality(trajectories);
        const avgQuality = filtered.length > 0
            ? filtered.reduce((sum, t) => sum + t.quality, 0) / filtered.length
            : 0;
        const avgSteps = filtered.length > 0
            ? filtered.reduce((sum, t) => sum + t.steps.length, 0) / filtered.length
            : 0;
        return {
            total: trajectories.length,
            filtered: filtered.length,
            avgQuality: Math.round(avgQuality * 100) / 100,
            avgSteps: Math.round(avgSteps * 10) / 10,
        };
    }
}
exports.TrajectoryExporter = TrajectoryExporter;
