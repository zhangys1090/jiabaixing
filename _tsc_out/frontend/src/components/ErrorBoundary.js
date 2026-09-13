"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const errorMonitoring_1 = require("../utils/errorMonitoring");
class ErrorBoundary extends react_1.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error('[ErrorBoundary] Caught an error:', error);
        console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
        errorMonitoring_1.errorMonitor.reportCustomError(`[ErrorBoundary] ${error.message}`, errorMonitoring_1.ErrorLevel.ERROR, {
            componentStack: errorInfo.componentStack,
            errorStack: error.stack,
        });
    }
    handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };
    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }
            return ((0, jsx_runtime_1.jsxs)("div", { style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '48px 24px',
                    textAlign: 'center',
                    color: 'var(--text-secondary, #888)',
                    fontFamily: 'var(--font-family, system-ui, sans-serif)',
                }, children: [(0, jsx_runtime_1.jsx)("div", { style: {
                            fontSize: '48px',
                            marginBottom: '16px',
                            lineHeight: 1,
                        }, children: "\u26A0\uFE0F" }), (0, jsx_runtime_1.jsx)("h3", { style: {
                            margin: '0 0 8px',
                            fontSize: '18px',
                            fontWeight: 600,
                            color: 'var(--text-primary, #e0e0e0)',
                        }, children: "Something went wrong" }), (0, jsx_runtime_1.jsx)("p", { style: {
                            margin: '0 0 20px',
                            fontSize: '14px',
                            maxWidth: '400px',
                            lineHeight: 1.5,
                            wordBreak: 'break-word',
                        }, children: this.state.error?.message || 'An unexpected error occurred while rendering this module.' }), (0, jsx_runtime_1.jsx)("button", { onClick: this.handleRetry, style: {
                            padding: '8px 24px',
                            fontSize: '14px',
                            fontWeight: 500,
                            border: '1px solid var(--border-color, #444)',
                            borderRadius: '6px',
                            background: 'var(--bg-secondary, #2a2a2a)',
                            color: 'var(--text-primary, #e0e0e0)',
                            cursor: 'pointer',
                            transition: 'background 0.15s ease',
                        }, onMouseEnter: (e) => {
                            e.currentTarget.style.background = 'var(--bg-hover, #333)';
                        }, onMouseLeave: (e) => {
                            e.currentTarget.style.background = 'var(--bg-secondary, #2a2a2a)';
                        }, children: "Retry" })] }));
        }
        return this.props.children;
    }
}
exports.default = ErrorBoundary;
