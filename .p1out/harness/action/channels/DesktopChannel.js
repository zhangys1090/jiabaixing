"use strict";
/**
 * DesktopChannel —— 桌面动作通道适配器
 *
 * 将 DesktopActionExecutor.executeAction(...) 归一为 ActionChannel 契约。
 * 若请求携带 verify，则在动作执行后接回 VerificationBridge（→ Python ActionVerifier）
 * 形成「执行 → 验证」闭环，这是 P1-2 桌面动作接回 action_verifier 的关键落点。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopChannel = void 0;
const Logger_1 = require("../../../utils/Logger");
class DesktopChannel {
    constructor(executor, verifier) {
        this.executor = executor;
        this.verifier = verifier;
        this.kind = 'desktop';
    }
    async dispatch(request) {
        const start = Date.now();
        const action = request.desktopAction;
        if (!action) {
            return {
                channel: 'desktop',
                success: false,
                output: null,
                error: 'DesktopChannel 需要 request.desktopAction',
                durationMs: Date.now() - start,
            };
        }
        try {
            const result = await this.executor.executeAction(action);
            let verification;
            if (request.verify && this.verifier) {
                try {
                    verification = await this.verifier.verify(request.verify);
                }
                catch (err) {
                    Logger_1.Logger.warn(`DesktopChannel 验证接回失败: ${err.message}`, 'DesktopChannel');
                }
            }
            return {
                channel: 'desktop',
                success: result.success,
                output: result.output ??
                    (result.observation ? '[observation]' : null),
                error: result.error,
                durationMs: Date.now() - start,
                raw: result,
                verification,
            };
        }
        catch (err) {
            Logger_1.Logger.error('DesktopChannel 执行失败', err, 'DesktopChannel');
            return {
                channel: 'desktop',
                success: false,
                output: null,
                error: err.message,
                durationMs: Date.now() - start,
            };
        }
    }
}
exports.DesktopChannel = DesktopChannel;
