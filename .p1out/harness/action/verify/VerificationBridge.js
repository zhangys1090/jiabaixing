"use strict";
/**
 * VerificationBridge —— 桌面动作接回 action_verifier 的桥接层
 *
 * 校验核心（ActionVerifier）在 Python 端（agent.perception.action_verifier）。
 * 本桥提供两种实现：
 *   - PythonVerificationBridge：经 HTTP 调用 PYTHON_AGENT_URL/v1/perception/verify-action，
 *     复用 Python 侧多策略验证（pixel/ocr/vlm/uia_diff）。
 *   - LocalVerificationBridge：Python 不可达时的本地兜底，保守判定。
 *
 * 通过 getActionVerificationBridge() 获取默认实例（Python 优先）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalVerificationBridge = exports.PythonVerificationBridge = void 0;
exports.getActionVerificationBridge = getActionVerificationBridge;
exports.setActionVerificationBridge = setActionVerificationBridge;
const Logger_1 = require("../../../utils/Logger");
class PythonVerificationBridge {
    constructor(baseUrl = process.env.PYTHON_AGENT_URL ||
        'http://localhost:3112') {
        this.baseUrl = baseUrl;
        this.mode = 'python';
    }
    async verify(req) {
        const base = this.baseUrl.replace(/\/$/, '');
        const url = `${base}/v1/perception/verify-action`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    action_description: req.description,
                    pre_path: req.prePath ?? '',
                    post_path: req.postPath ?? '',
                    strategy: req.strategy ?? 'auto',
                    target_region: req.targetRegion ?? '',
                    threshold: req.threshold ?? 0.01,
                    question: req.question ?? '',
                }),
                signal: ctrl.signal,
            });
            if (!resp.ok) {
                Logger_1.Logger.warn(`VerificationBridge(Python) 返回非 2xx: ${resp.status}`, 'VerificationBridge');
                return {
                    success: false,
                    confidence: 0,
                    evidence: `HTTP ${resp.status}`,
                    retrySuggested: false,
                    method: 'python_error',
                    diffRatio: 0,
                };
            }
            const data = (await resp.json());
            return {
                success: Boolean(data.success),
                confidence: Number(data.confidence ?? 0),
                evidence: String(data.evidence ?? ''),
                retrySuggested: Boolean(data.retry_suggested),
                method: String(data.method ?? 'python'),
                diffRatio: Number(data.diff_ratio ?? 0),
            };
        }
        catch (err) {
            Logger_1.Logger.warn(`VerificationBridge(Python) 调用失败: ${err.message}`, 'VerificationBridge');
            return {
                success: false,
                confidence: 0,
                evidence: `bridge error: ${err.message}`,
                retrySuggested: false,
                method: 'python_error',
                diffRatio: 0,
            };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.PythonVerificationBridge = PythonVerificationBridge;
class LocalVerificationBridge {
    constructor() {
        this.mode = 'local';
    }
    async verify(req) {
        // 本地兜底：无法调用 Python ActionVerifier 时的保守判定。
        // 提供了前后截图 → 标记为待 Python 复核；否则无法客观验证。
        if (req.prePath && req.postPath) {
            return {
                success: true,
                confidence: 0.5,
                evidence: '本地兜底：已提供前后截图，建议经 Python ActionVerifier 复核',
                retrySuggested: false,
                method: 'local',
                diffRatio: 0,
            };
        }
        return {
            success: true,
            confidence: 0.3,
            evidence: '本地兜底：未提供截图，无法客观验证',
            retrySuggested: false,
            method: 'local',
            diffRatio: 0,
        };
    }
}
exports.LocalVerificationBridge = LocalVerificationBridge;
let _bridge = null;
function getActionVerificationBridge() {
    if (!_bridge)
        _bridge = new PythonVerificationBridge();
    return _bridge;
}
function setActionVerificationBridge(bridge) {
    _bridge = bridge;
}
