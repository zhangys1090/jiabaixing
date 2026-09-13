"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * Human-in-the-Loop 审批弹窗组件
 *
 * 当有 pending approval 时弹出，显示工具名、参数、风险等级，
 * 用户可以批准或拒绝。
 */
const react_1 = require("react");
const apiService_1 = require("../../api/apiService");
require("./ApprovalDialog.css");
const RISK_COLORS = {
    low: '#4caf50',
    medium: '#ff9800',
    high: '#f44336',
    critical: '#9c27b0',
};
const RISK_LABELS = {
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    critical: '极高风险',
};
const TIMEOUT_MS = 120000;
const ApprovalDialog = ({ visible, pendingRequests, onClose, }) => {
    const [rejectReason, setRejectReason] = (0, react_1.useState)('');
    const [responding, setResponding] = (0, react_1.useState)(null);
    const [countdowns, setCountdowns] = (0, react_1.useState)({});
    // 超时倒计时
    (0, react_1.useEffect)(() => {
        if (!visible || pendingRequests.length === 0)
            return;
        const interval = setInterval(() => {
            const updated = {};
            for (const req of pendingRequests) {
                const elapsed = Date.now() - req.timestamp;
                const remaining = Math.max(0, TIMEOUT_MS - elapsed);
                updated[req.id] = Math.ceil(remaining / 1000);
            }
            setCountdowns(updated);
        }, 1000);
        return () => clearInterval(interval);
    }, [visible, pendingRequests]);
    const handleRespond = (0, react_1.useCallback)(async (requestId, approved) => {
        setResponding(requestId);
        try {
            const baseUrl = (0, apiService_1.getApiBaseUrl)();
            const response = await fetch(`${baseUrl}/api/approval/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requestId,
                    approved,
                    reason: approved ? undefined : rejectReason || undefined,
                }),
            });
            const data = await response.json();
            if (!data.success) {
                console.error('审批响应失败:', data.error);
            }
        }
        catch (err) {
            console.error('审批请求失败:', err);
        }
        finally {
            setResponding(null);
            setRejectReason('');
        }
    }, [rejectReason]);
    if (!visible || pendingRequests.length === 0)
        return null;
    const currentRequest = pendingRequests[0];
    const riskColor = RISK_COLORS[currentRequest.riskLevel] || '#757575';
    const riskLabel = RISK_LABELS[currentRequest.riskLevel] || currentRequest.riskLevel;
    const countdown = countdowns[currentRequest.id] ?? 120;
    return ((0, jsx_runtime_1.jsx)("div", { className: "approval-overlay", onClick: onClose, children: (0, jsx_runtime_1.jsxs)("div", { className: "approval-dialog", onClick: (e) => e.stopPropagation(), role: "dialog", "aria-modal": "true", "aria-label": "\u5DE5\u5177\u5BA1\u6279\u786E\u8BA4", children: [(0, jsx_runtime_1.jsxs)("div", { className: "approval-header", children: [(0, jsx_runtime_1.jsx)("h2", { children: "\uD83D\uDD10 \u5DE5\u5177\u5BA1\u6279\u786E\u8BA4" }), (0, jsx_runtime_1.jsx)("span", { className: "approval-risk-badge", style: { backgroundColor: riskColor }, children: riskLabel })] }), (0, jsx_runtime_1.jsxs)("div", { className: "approval-body", children: [(0, jsx_runtime_1.jsxs)("div", { className: "approval-info", children: [(0, jsx_runtime_1.jsxs)("div", { className: "approval-field", children: [(0, jsx_runtime_1.jsx)("span", { className: "approval-label", children: "\u5DE5\u5177\u540D\u79F0" }), (0, jsx_runtime_1.jsx)("span", { className: "approval-value approval-tool-name", children: currentRequest.toolName })] }), (0, jsx_runtime_1.jsxs)("div", { className: "approval-field", children: [(0, jsx_runtime_1.jsx)("span", { className: "approval-label", children: "\u8C03\u7528\u53C2\u6570" }), (0, jsx_runtime_1.jsx)("pre", { className: "approval-params", children: JSON.stringify(currentRequest.params, null, 2) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "approval-field", children: [(0, jsx_runtime_1.jsx)("span", { className: "approval-label", children: "\u8D85\u65F6\u5012\u8BA1\u65F6" }), (0, jsx_runtime_1.jsxs)("span", { className: `approval-countdown ${countdown < 30 ? 'urgent' : ''}`, children: [countdown, "s"] })] })] }), pendingRequests.length > 1 && ((0, jsx_runtime_1.jsxs)("div", { className: "approval-queue", children: ["\u961F\u5217\u4E2D\u8FD8\u6709 ", pendingRequests.length - 1, " \u4E2A\u5F85\u5BA1\u6279\u8BF7\u6C42"] })), (0, jsx_runtime_1.jsxs)("div", { className: "approval-reason", children: [(0, jsx_runtime_1.jsx)("label", { className: "approval-label", htmlFor: "reject-reason", children: "\u62D2\u7EDD\u539F\u56E0\uFF08\u53EF\u9009\uFF09" }), (0, jsx_runtime_1.jsx)("input", { id: "reject-reason", type: "text", className: "approval-reason-input", placeholder: "\u8F93\u5165\u62D2\u7EDD\u539F\u56E0...", value: rejectReason, onChange: (e) => setRejectReason(e.target.value) })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "approval-actions", children: [(0, jsx_runtime_1.jsx)("button", { className: "approval-btn approval-btn-reject", onClick: () => handleRespond(currentRequest.id, false), disabled: responding === currentRequest.id, children: responding === currentRequest.id ? '处理中...' : '❌ 拒绝' }), (0, jsx_runtime_1.jsx)("button", { className: "approval-btn approval-btn-approve", onClick: () => handleRespond(currentRequest.id, true), disabled: responding === currentRequest.id, children: responding === currentRequest.id ? '处理中...' : '✅ 批准' })] })] }) }));
};
exports.default = ApprovalDialog;
