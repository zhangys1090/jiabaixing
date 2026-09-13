"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToastProvider = ToastProvider;
exports.useToast = useToast;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const ToastContext = (0, react_1.createContext)(undefined);
let toastIdCounter = 0;
function generateToastId() {
    return `toast_${Date.now()}_${++toastIdCounter}`;
}
function ToastProvider({ children }) {
    const [toasts, setToasts] = (0, react_1.useState)([]);
    const dismissToast = (0, react_1.useCallback)((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);
    const showToast = (0, react_1.useCallback)((message, type = 'info', duration = 4000) => {
        const id = generateToastId();
        const toast = { id, message, type, duration };
        setToasts((prev) => [...prev.slice(-4), toast]);
        if (duration > 0) {
            setTimeout(() => {
                dismissToast(id);
            }, duration);
        }
    }, [dismissToast]);
    const showSuccess = (0, react_1.useCallback)((message, duration) => showToast(message, 'success', duration), [showToast]);
    const showError = (0, react_1.useCallback)((message, duration) => showToast(message, 'error', duration), [showToast]);
    const showWarning = (0, react_1.useCallback)((message, duration) => showToast(message, 'warning', duration), [showToast]);
    const showInfo = (0, react_1.useCallback)((message, duration) => showToast(message, 'info', duration), [showToast]);
    const clearAll = (0, react_1.useCallback)(() => {
        setToasts([]);
    }, []);
    const value = (0, react_1.useMemo)(() => ({
        toasts,
        showToast,
        showSuccess,
        showError,
        showWarning,
        showInfo,
        dismissToast,
        clearAll,
    }), [toasts, showToast, showSuccess, showError, showWarning, showInfo, dismissToast, clearAll]);
    return (0, jsx_runtime_1.jsx)(ToastContext.Provider, { value: value, children: children });
}
function useToast() {
    const context = (0, react_1.useContext)(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}
