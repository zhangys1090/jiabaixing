"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToastContainer = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const ToastContext_1 = require("../../contexts/ToastContext");
require("./Toast.css");
const ICONS = {
    success: 'O',
    error: 'X',
    warning: '!',
    info: 'i',
};
const TYPE_CLASS = {
    success: 'toast--success',
    error: 'toast--error',
    warning: 'toast--warning',
    info: 'toast--info',
};
const ToastContainer = () => {
    const { toasts, dismissToast } = (0, ToastContext_1.useToast)();
    if (toasts.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsx)("div", { className: "toast-container", role: "region", "aria-live": "polite", "aria-label": "\u901A\u77E5", children: toasts.map((toast) => ((0, jsx_runtime_1.jsxs)("div", { className: `toast ${TYPE_CLASS[toast.type] || 'toast--info'}`, onClick: () => dismissToast(toast.id), role: "status", children: [(0, jsx_runtime_1.jsx)("span", { className: "toast__icon", children: ICONS[toast.type] || 'i' }), (0, jsx_runtime_1.jsx)("span", { className: "toast__message", children: toast.message }), (0, jsx_runtime_1.jsx)("button", { className: "toast__close", onClick: (e) => {
                        e.stopPropagation();
                        dismissToast(toast.id);
                    }, "aria-label": "\u5173\u95ED\u901A\u77E5", children: "\u00D7" })] }, toast.id))) }));
};
exports.ToastContainer = ToastContainer;
exports.default = exports.ToastContainer;
