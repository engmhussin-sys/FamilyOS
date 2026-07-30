import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  getPersistedLocale,
  isRtl,
  persistLocale,
  translate,
  type Locale,
  type TranslateOptions,
} from './localizationEngine';

interface ILocaleContext {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, options?: TranslateOptions) => string;
  isRtl: boolean;
}

const LocaleContext = createContext<ILocaleContext | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => getPersistedLocale() ?? DEFAULT_LOCALE);

  useEffect(() => {
    document.documentElement.dir = isRtl(locale) ? 'rtl' : 'ltr';
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (next: Locale) => {
    persistLocale(next);
    setLocaleState(next);
  };

  const value = useMemo<ILocaleContext>(
    () => ({
      locale,
      setLocale,
      t: (key, options) => translate(locale, key, options),
      isRtl: isRtl(locale),
    }),
    [locale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** The one hook every component should use \u2014 never import
 * `localizationEngine.ts` directly (that module is the Provider's own
 * implementation detail, not a public API components should couple to). */
export function useTranslation(): ILocaleContext {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useTranslation must be used within a LocaleProvider.');
  }
  return context;
}
