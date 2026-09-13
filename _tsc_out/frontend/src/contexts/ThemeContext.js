"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useTheme = exports.ThemeProvider = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const ThemeContext = (0, react_1.createContext)(undefined);
const ThemeProvider = ({ children }) => {
    const [theme, setThemeState] = (0, react_1.useState)(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('jiabaixing-theme');
            if (saved)
                return saved;
        }
        return 'dark'; // 默认暗色主题
    });
    (0, react_1.useEffect)(() => {
        const root = document.documentElement;
        root.classList.remove('theme-dark', 'theme-light');
        root.classList.add(`theme-${theme}`);
        localStorage.setItem('jiabaixing-theme', theme);
    }, [theme]);
    const toggleTheme = () => {
        setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
    };
    const setTheme = (newTheme) => {
        setThemeState(newTheme);
    };
    return (0, jsx_runtime_1.jsx)(ThemeContext.Provider, { value: { theme, toggleTheme, setTheme }, children: children });
};
exports.ThemeProvider = ThemeProvider;
const useTheme = () => {
    const context = (0, react_1.useContext)(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
exports.useTheme = useTheme;
exports.default = ThemeContext;
