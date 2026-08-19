"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizationScheduler = void 0;
const fs = __importStar(require("fs"));
const path_1 = __importDefault(require("path"));
const EventBus_1 = require("../shared/EventBus");
const Logger_1 = require("../utils/Logger");
class OptimizationScheduler {
    constructor(deps) {
        this.deps = deps;
        this.optimizationScheduler = null;
    }
    async applyOptimizationsFromReport() {
        const traceId = Logger_1.Logger.generateTraceId();
        Logger_1.Logger.setTraceId(traceId);
        const reportPath = path_1.default.join(process.cwd(), 'data', 'feedback', 'feedback_analysis_report.json');
        Logger_1.Logger.info('🤖 自动优化调度：开始扫描优化报告...', 'OptimizationScheduler');
        if (!fs.existsSync(reportPath)) {
            Logger_1.Logger.info(`⏭️ 自动优化调度：未找到报告文件 (${reportPath})，跳过`, 'OptimizationScheduler');
            Logger_1.Logger.clearTraceId();
            return;
        }
        try {
            const reportContent = await fs.promises.readFile(reportPath, 'utf-8');
            const report = JSON.parse(reportContent);
            const reportTimestamp = report.timestamp || report.generatedAt || '未知';
            const analysisWindowStr = typeof report.analysisWindow === 'string'
                ? report.analysisWindow
                : `${report.analysisWindow.start} ~ ${report.analysisWindow.end}`;
            Logger_1.Logger.info(`📊 自动优化调度：加载报告 [${reportTimestamp}]，分析窗口: ${analysisWindowStr}`, 'OptimizationScheduler');
            if (report.heuristicSuggestions &&
                report.heuristicSuggestions.length > 0) {
                Logger_1.Logger.info(`启发式建议: ${report.heuristicSuggestions.length} 项（由 LLM FC 循环自动处理）`, 'OptimizationScheduler');
            }
            Logger_1.Logger.info(`✅ 自动优化调度：处理完成（工具权重调整由 LLM FC 循环驱动）`, 'OptimizationScheduler');
        }
        catch (error) {
            Logger_1.Logger.error('❌ 自动优化调度：处理报告失败', error, 'OptimizationScheduler');
        }
        Logger_1.Logger.clearTraceId();
    }
    watchAnalysisReport() {
        const reportPath = path_1.default.join(process.cwd(), 'data', 'feedback', 'feedback_analysis_report.json');
        fs.watchFile(reportPath, { interval: 10000 }, async (curr, prev) => {
            if (curr.mtimeMs !== prev.mtimeMs) {
                Logger_1.Logger.info('📡 检测到优化报告更新，正在热加载...', 'OptimizationScheduler');
                await this.applyOptimizationsFromReport();
                Logger_1.Logger.info('✅ 优化报告已热加载', 'OptimizationScheduler');
            }
        });
        Logger_1.Logger.info('🔍 已启动优化报告热监视', 'OptimizationScheduler');
    }
    startOptimizationScheduler() {
        const INTERVAL_24H = 24 * 60 * 60 * 1000;
        this.optimizationScheduler = setInterval(async () => {
            Logger_1.Logger.info('⏰ 定时调度触发：开始执行自动优化...', 'OptimizationScheduler');
            await this.applyOptimizationsFromReport();
        }, INTERVAL_24H);
        if (this.optimizationScheduler.unref)
            this.optimizationScheduler.unref();
        Logger_1.Logger.info(`⏰ 自动优化定时调度已启动，间隔: 24小时`, 'OptimizationScheduler');
    }
    setupUserCorrectionHandler() {
        EventBus_1.EventBus.on('user_correction', async (data) => {
            try {
                const payload = data;
                const toolId = (payload.toolId || payload.tool_name);
                const correctionType = (payload.correctionType ||
                    payload.type);
                const reason = (payload.reason || payload.message);
                const severity = Number(payload.severity) || 1;
                const traceId = (payload.traceId || payload.trace_id);
                if (!toolId) {
                    Logger_1.Logger.warn('⚠️ user_correction事件缺少toolId', 'OptimizationScheduler');
                    return;
                }
                const mem = this.deps.memoryEngine;
                if (mem?.storeFeedbackSignal) {
                    await mem.storeFeedbackSignal({
                        traceId,
                        toolName: toolId,
                        feedbackType: 'correction',
                        rating: severity > 0 ? 1 : 4,
                        message: `[${correctionType}] ${reason || '未提供原因'}`,
                    });
                }
                Logger_1.Logger.info(`🎯 用户纠错已记录: [${toolId}] ${correctionType}, 原因: ${reason}`, 'OptimizationScheduler');
            }
            catch (error) {
                Logger_1.Logger.warn('⚠️ 处理user_correction事件失败: ' + error.message, 'OptimizationScheduler');
            }
        });
        Logger_1.Logger.info('✅ user_correction事件监听器已注册', 'OptimizationScheduler');
    }
    shutdown() {
        if (this.optimizationScheduler) {
            clearInterval(this.optimizationScheduler);
            this.optimizationScheduler = null;
        }
    }
}
exports.OptimizationScheduler = OptimizationScheduler;
