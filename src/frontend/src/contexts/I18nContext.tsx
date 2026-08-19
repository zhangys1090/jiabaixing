import React, { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { DEFAULT_LOCALE, getNestedValue, Locale, LOCALE_LABELS, MESSAGES, TranslationMessages } from '../i18n';

const STORAGE_KEY = 'jbx_pref_locale';

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, fallback?: string) => string;
  messages: TranslationMessages;
  availableLocales: Locale[];
  localeLabels: Record<Locale, string>;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function detectLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  const saved = localStorage.getItem(STORAGE_KEY) as Locale;
  if (saved && MESSAGES[saved]) return saved;

  const browserLang = navigator.language;
  if (browserLang.startsWith('zh')) return 'zh-CN';
  if (browserLang.startsWith('ja')) return 'ja-JP';
  if (browserLang.startsWith('en')) return 'en-US';

  return DEFAULT_LOCALE;
}

export const I18nProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.setAttribute('lang', locale);
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    if (MESSAGES[newLocale]) {
      setLocaleState(newLocale);
    }
  }, []);

  const t = useCallback(
    (key: string, fallback?: string): string => {
      const value = getNestedValue(MESSAGES[locale], key);
      if (value) return value;

      if (fallback) return fallback;

      const zhValue = getNestedValue(MESSAGES['zh-CN'], key);
      if (zhValue) return zhValue;

      return key;
    },
    [locale]
  );

  const contextValue: I18nContextType = {
    locale,
    setLocale,
    t,
    messages: MESSAGES[locale],
    availableLocales: Object.keys(MESSAGES) as Locale[],
    localeLabels: LOCALE_LABELS,
  };

  return <I18nContext.Provider value={contextValue}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextType {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}

export function useTranslation() {
  const { t, locale, setLocale } = useI18n();
  return { t, locale, setLocale };
}

export default I18nContext;
