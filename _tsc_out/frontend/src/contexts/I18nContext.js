"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.I18nProvider = void 0;
exports.useI18n = useI18n;
exports.useTranslation = useTranslation;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const i18n_1 = require("../i18n");
const STORAGE_KEY = 'jbx_pref_locale';
const I18nContext = (0, react_1.createContext)(undefined);
function detectLocale() {
    if (typeof window === 'undefined')
        return i18n_1.DEFAULT_LOCALE;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && i18n_1.MESSAGES[saved])
        return saved;
    const browserLang = navigator.language;
    if (browserLang.startsWith('zh'))
        return 'zh-CN';
    if (browserLang.startsWith('ja'))
        return 'ja-JP';
    if (browserLang.startsWith('en'))
        return 'en-US';
    return i18n_1.DEFAULT_LOCALE;
}
const I18nProvider = ({ children }) => {
    const [locale, setLocaleState] = (0, react_1.useState)(detectLocale);
    (0, react_1.useEffect)(() => {
        localStorage.setItem(STORAGE_KEY, locale);
        document.documentElement.setAttribute('lang', locale);
    }, [locale]);
    const setLocale = (0, react_1.useCallback)((newLocale) => {
        if (i18n_1.MESSAGES[newLocale]) {
            setLocaleState(newLocale);
        }
    }, []);
    const t = (0, react_1.useCallback)((key, fallback) => {
        const value = (0, i18n_1.getNestedValue)(i18n_1.MESSAGES[locale], key);
        if (value)
            return value;
        if (fallback)
            return fallback;
        const zhValue = (0, i18n_1.getNestedValue)(i18n_1.MESSAGES['zh-CN'], key);
        if (zhValue)
            return zhValue;
        return key;
    }, [locale]);
    const contextValue = {
        locale,
        setLocale,
        t,
        messages: i18n_1.MESSAGES[locale],
        availableLocales: Object.keys(i18n_1.MESSAGES),
        localeLabels: i18n_1.LOCALE_LABELS,
    };
    return (0, jsx_runtime_1.jsx)(I18nContext.Provider, { value: contextValue, children: children });
};
exports.I18nProvider = I18nProvider;
function useI18n() {
    const context = (0, react_1.useContext)(I18nContext);
    if (!context) {
        throw new Error('useI18n must be used within an I18nProvider');
    }
    return context;
}
function useTranslation() {
    const { t, locale, setLocale } = useI18n();
    return { t, locale, setLocale };
}
exports.default = I18nContext;
