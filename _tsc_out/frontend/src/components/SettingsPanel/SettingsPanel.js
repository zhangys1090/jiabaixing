"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
/**
 * 设置面板 v3 - LLM 多模型管理
 * 使用 base-panel.css 通用类库 + Toast 通知
 */
const react_1 = require("react");
const apiService_1 = require("../../api/apiService");
const I18nContext_1 = require("../../contexts/I18nContext");
const ToastContext_1 = require("../../contexts/ToastContext");
const i18n_1 = require("../../i18n");
const useVoiceStore_1 = require("../../stores/useVoiceStore");
require("./SettingsPanel.css");
function asLLMStatus(data) {
    return data;
}
const SettingsPanel = () => {
    const [llmStatus, setLlmStatus] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [switchingId, setSwitchingId] = (0, react_1.useState)(null);
    const { showSuccess, showError } = (0, ToastContext_1.useToast)();
    const { locale, setLocale, t } = (0, I18nContext_1.useI18n)();
    const { settings: voiceSettings, updateSettings: updateVoiceSettings } = (0, useVoiceStore_1.useVoiceStore)();
    const fetchStatus = (0, react_1.useCallback)(async () => {
        setLoading(true);
        try {
            const result = await apiService_1.apiService.getModelStatus();
            if (result.success && result.data) {
                const status = asLLMStatus(result.data);
                setLlmStatus(status);
            }
            else {
                showError(result.error || '获取模型状态失败');
            }
        }
        catch (e) {
            setLlmStatus(null);
            showError(`获取模型状态失败: ${e.message}`);
        }
        finally {
            setLoading(false);
        }
    }, [showError]);
    (0, react_1.useEffect)(() => {
        fetchStatus();
    }, [fetchStatus]);
    const handleSwitchModel = (0, react_1.useCallback)(async (modelId) => {
        setSwitchingId(modelId);
        try {
            const result = await apiService_1.apiService.switchModel(modelId);
            if (result.success && result.data) {
                const status = asLLMStatus(result.data);
                setLlmStatus(status);
                showSuccess('模型切换成功，已即时生效');
            }
            else {
                showError(`切换失败: ${result.error || '未知错误'}`);
            }
        }
        catch (e) {
            showError(`网络错误: ${e.message}`);
        }
        finally {
            setSwitchingId(null);
        }
    }, [showSuccess, showError]);
    const handleToggleEnabled = (0, react_1.useCallback)(async (modelId, enabled) => {
        setSwitchingId(modelId);
        try {
            const result = await apiService_1.apiService.switchModel(modelId, enabled ? '启用' : '禁用');
            if (result.success && result.data) {
                const status = asLLMStatus(result.data);
                setLlmStatus(status);
                showSuccess(enabled ? '模型已启用' : '模型已禁用');
            }
            else {
                showError(`操作失败: ${result.error || '未知错误'}`);
            }
        }
        catch (e) {
            showError(`操作失败: ${e.message}`);
        }
        finally {
            setSwitchingId(null);
        }
    }, [showSuccess, showError]);
    const handleHealthCheck = (0, react_1.useCallback)(async () => {
        setLoading(true);
        try {
            const result = await apiService_1.apiService.getModelHealth();
            if (result.success) {
                showSuccess('健康检查完成');
            }
            else {
                showError(result.error || '健康检查失败');
            }
        }
        catch (e) {
            showError(`健康检查失败: ${e.message}`);
        }
        finally {
            setLoading(false);
        }
    }, [showSuccess, showError]);
    const currentModelInfo = llmStatus?.availableModels.find((m) => m.priority === 1);
    const renderCapabilityBar = (label, score) => ((0, jsx_runtime_1.jsxs)("div", { className: "settings-capability", children: [(0, jsx_runtime_1.jsx)("span", { className: "settings-capability__label", children: label }), (0, jsx_runtime_1.jsx)("div", { className: "gauge", children: (0, jsx_runtime_1.jsx)("div", { className: "gauge-fill", style: { width: `${Math.max(0, Math.min(100, score))}%` } }) }), (0, jsx_runtime_1.jsx)("span", { className: "settings-capability__score", children: score })] }, label));
    return ((0, jsx_runtime_1.jsxs)("div", { className: "panel-container settings-panel", children: [(0, jsx_runtime_1.jsxs)("header", { className: "panel-header", children: [(0, jsx_runtime_1.jsx)("h2", { className: "panel-title", children: "LLM \u6A21\u578B\u7BA1\u7406" }), (0, jsx_runtime_1.jsx)("p", { className: "panel-subtitle", children: "\u591A\u6A21\u578B\u70ED\u5207\u6362 \u00B7 \u672C\u5730+\u4E91\u7AEF\u53CC\u67B6\u6784 \u00B7 \u65E0\u9700\u91CD\u542F" })] }), (0, jsx_runtime_1.jsxs)("section", { className: "function-node", children: [(0, jsx_runtime_1.jsx)("h3", { className: "section-title section-title--large", children: "\u5F53\u524D\u6D3B\u8DC3\u6A21\u578B" }), loading && !currentModelInfo ? ((0, jsx_runtime_1.jsxs)("div", { className: "loading-msg", children: [(0, jsx_runtime_1.jsx)("span", { className: "spinner" }), " \u52A0\u8F7D\u4E2D..."] })) : currentModelInfo ? ((0, jsx_runtime_1.jsxs)("div", { className: "settings-active-model", children: [(0, jsx_runtime_1.jsxs)("div", { className: "settings-active-model__header", children: [(0, jsx_runtime_1.jsx)("span", { className: `badge ${currentModelInfo.available ? 'badge--success' : 'badge--danger'}`, children: currentModelInfo.available ? '在线' : '离线' }), (0, jsx_runtime_1.jsx)("span", { className: "settings-active-model__name", children: currentModelInfo.name })] }), (0, jsx_runtime_1.jsxs)("div", { className: "settings-active-model__tags", children: [currentModelInfo.capabilities.features.map((f) => ((0, jsx_runtime_1.jsx)("span", { className: "tag tag--active", children: f }, f))), (0, jsx_runtime_1.jsxs)("span", { className: "tag", children: [currentModelInfo.capabilities.contextLength.toLocaleString(), " tokens"] })] })] })) : ((0, jsx_runtime_1.jsx)("div", { className: "empty-hint", children: "\u65E0\u53EF\u7528\u6A21\u578B" }))] }), (0, jsx_runtime_1.jsxs)("section", { className: "section", children: [(0, jsx_runtime_1.jsx)("h3", { className: "section-title section-title--large", children: "\u5DF2\u6CE8\u518C\u6A21\u578B" }), loading && !llmStatus ? ((0, jsx_runtime_1.jsxs)("div", { className: "loading-msg", children: [(0, jsx_runtime_1.jsx)("span", { className: "spinner" }), " \u52A0\u8F7D\u6A21\u578B\u5217\u8868..."] })) : llmStatus?.availableModels && llmStatus.availableModels.length > 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "settings-model-list", children: llmStatus.availableModels.map((model) => ((0, jsx_runtime_1.jsxs)("div", { className: `function-node settings-model-card ${model.priority === 1 ? 'settings-model-card--active' : ''}`, children: [(0, jsx_runtime_1.jsxs)("div", { className: "settings-model-card__header", children: [(0, jsx_runtime_1.jsxs)("div", { className: "settings-model-card__info", children: [(0, jsx_runtime_1.jsx)("span", { className: `badge ${model.available ? 'badge--success' : 'badge--danger'}`, children: model.available ? '在线' : '离线' }), (0, jsx_runtime_1.jsx)("span", { className: "settings-model-card__name", children: model.name }), model.priority === 1 && (0, jsx_runtime_1.jsx)("span", { className: "badge badge--info", children: "\u6D3B\u8DC3" })] }), (0, jsx_runtime_1.jsx)("span", { className: "tag", children: model.id })] }), (0, jsx_runtime_1.jsxs)("div", { className: "settings-model-card__capabilities", children: [renderCapabilityBar('代码', model.capabilities.codingScore), renderCapabilityBar('推理', model.capabilities.reasoningScore), renderCapabilityBar('速度', model.capabilities.speedScore)] }), (0, jsx_runtime_1.jsxs)("div", { className: "action-bar action-bar--right", children: [model.priority !== 1 && model.available && ((0, jsx_runtime_1.jsxs)("button", { className: "btn btn--primary", onClick: () => handleSwitchModel(model.id), disabled: switchingId === model.id || loading, children: [switchingId === model.id ? (0, jsx_runtime_1.jsx)("span", { className: "spinner" }) : null, switchingId === model.id ? '切换中...' : '切换到此模型'] })), (0, jsx_runtime_1.jsx)("button", { className: `btn ${model.enabled ? 'btn--danger' : 'btn--success'}`, onClick: () => handleToggleEnabled(model.id, !model.enabled), disabled: switchingId === model.id || loading, children: model.enabled ? '禁用' : '启用' })] })] }, model.id))) })) : ((0, jsx_runtime_1.jsx)("div", { className: "empty-hint", children: "\u6682\u65E0\u6A21\u578B\u6570\u636E" }))] }), (0, jsx_runtime_1.jsx)("section", { className: "subgroup", children: (0, jsx_runtime_1.jsxs)("div", { className: "action-bar", children: [(0, jsx_runtime_1.jsxs)("button", { className: "btn", onClick: handleHealthCheck, disabled: loading, children: [loading ? (0, jsx_runtime_1.jsx)("span", { className: "spinner" }) : null, "\u91CD\u65B0\u5065\u5EB7\u68C0\u67E5"] }), (0, jsx_runtime_1.jsx)("button", { className: "btn btn--primary", onClick: fetchStatus, disabled: loading, children: "\u5237\u65B0\u72B6\u6001" })] }) }), (0, jsx_runtime_1.jsxs)("section", { className: "section", children: [(0, jsx_runtime_1.jsx)("h3", { className: "section-title", children: t('settings.voice') }), (0, jsx_runtime_1.jsxs)("div", { className: "subgroup", children: [(0, jsx_runtime_1.jsxs)("div", { className: "settings-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "settings-label", children: t('settings.language') }), (0, jsx_runtime_1.jsx)("select", { value: locale, onChange: (e) => setLocale(e.target.value), className: "settings-select", children: Object.entries(i18n_1.LOCALE_LABELS).map(([code, label]) => ((0, jsx_runtime_1.jsx)("option", { value: code, children: label }, code))) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "settings-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "settings-label", children: "\u8BED\u97F3\u8BED\u8A00" }), (0, jsx_runtime_1.jsxs)("select", { value: voiceSettings.language, onChange: (e) => updateVoiceSettings({ language: e.target.value }), className: "settings-select", children: [(0, jsx_runtime_1.jsx)("option", { value: "zh-CN", children: "\u4E2D\u6587" }), (0, jsx_runtime_1.jsx)("option", { value: "en-US", children: "English" }), (0, jsx_runtime_1.jsx)("option", { value: "ja-JP", children: "\u65E5\u672C\u8A9E" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "settings-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "settings-label", children: "TTS \u8BED\u901F" }), (0, jsx_runtime_1.jsx)("input", { type: "range", min: "0.5", max: "2", step: "0.1", value: voiceSettings.ttsRate, onChange: (e) => updateVoiceSettings({ ttsRate: parseFloat(e.target.value) }), className: "settings-range" }), (0, jsx_runtime_1.jsxs)("span", { className: "settings-value", children: [voiceSettings.ttsRate.toFixed(1), "x"] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "settings-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "settings-label", children: t('settings.autoSpeak') }), (0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: voiceSettings.autoSpeak, onChange: (e) => updateVoiceSettings({ autoSpeak: e.target.checked }) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "settings-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "settings-label", children: t('settings.continuousMode') }), (0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: voiceSettings.continuousMode, onChange: (e) => updateVoiceSettings({ continuousMode: e.target.checked }) })] })] })] }), (0, jsx_runtime_1.jsxs)("section", { className: "section", children: [(0, jsx_runtime_1.jsx)("h3", { className: "section-title", children: "\u5173\u4E8E" }), (0, jsx_runtime_1.jsxs)("div", { className: "subgroup", children: [(0, jsx_runtime_1.jsx)("p", { className: "settings-version", children: "\u5BB6\u767E\u661F v2.0 \u2014 \u591A\u6A21\u578B\u667A\u80FD\u8DEF\u7531" }), (0, jsx_runtime_1.jsx)("p", { className: "settings-desc", children: "\u672C\u5730 LLM Server + \u4E91\u7AEF API \u53CC\u6A21\u578B\u67B6\u6784\u3002\u7CFB\u7EDF\u81EA\u52A8\u4F18\u5148\u4F7F\u7528\u672C\u5730\u6A21\u578B\uFF0C\u4E0D\u53EF\u7528\u65F6\u81EA\u52A8\u964D\u7EA7\u5230\u4E91\u7AEF\u3002 \u5207\u6362\u6A21\u578B\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u670D\u52A1\u3002" })] })] })] }));
};
exports.default = SettingsPanel;
