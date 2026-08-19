import en from './translations/en.json';
import ar from './translations/ar.json';

export type Locale = 'en' | 'ar';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'ar'];
/**
 * Arabic-first, not Arabic-also. CONTEXT §1: the first markets are Egypt and
 * Saudi Arabia and the first language is Arabic with real RTL — and
 * `index.html` has shipped `lang="ar" dir="rtl"` since Phase B, so an English
 * default made the very first paint disagree with the document element.
 */
export const DEFAULT_LOCALE: Locale = 'ar';
/**
 * A3 — THE FALLBACK IS THE DEFAULT LOCALE, AND IT DID NOT USE TO BE.
 *
 * This constant was `'en'` while `DEFAULT_LOCALE` was `'ar'`, and the two
 * Flutter engines (`apps/parent-app` and `apps/child-app`,
 * `lib/core/localization/localization_engine.dart`) fall back to their
 * default locale — Arabic — under a header that says, in those words, "Same
 * fallback strategy as the Dashboard's `translate()`". One of the three had
 * to move for that sentence to be true, and this is the one this change owns.
 *
 * WHY ARABIC RATHER THAN ENGLISH. The reason the Flutter side gives (audit
 * MA-016) applies here identically: a key missing from `ar.json` used to
 * surface an ENGLISH string inside an otherwise-Arabic, RTL screen — a
 * visibly foreign sentence in the product's first language, in the two
 * markets it launches in. Falling back to the default locale keeps the screen
 * in one language; a key missing from BOTH files still renders as the raw key
 * rather than blank, which is unchanged.
 *
 * WHAT THIS CHANGES TODAY: nothing that renders. `en.json` and `ar.json` are
 * at full key parity and a test in `test/i18n/localizationEngine.spec.ts`
 * asserts that, so this path is unreachable until parity breaks. That is the
 * point of converging it while it is still free.
 *
 * NOT TOUCHED, DELIBERATELY: the two Flutter engines. They already fall back
 * to Arabic and are owned elsewhere; the only thing left for their owner is
 * that their header now describes the Dashboard accurately.
 */
export const FALLBACK_LOCALE: Locale = DEFAULT_LOCALE;
export const RTL_LOCALES: Locale[] = ['ar'];

const RESOURCES: Record<Locale, Record<string, unknown>> = { en, ar };

const LOCALE_STORAGE_KEY = 'afdc_locale';

/** Resource Loader — flattens `{"a": {"b": "c"}}` into `"a.b" -> "c"` once
 * per locale, so lookups are O(1) string-key reads instead of walking
 * the nested object on every `t()` call. */
function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result[fullKey] = value;
    } else if (typeof value === 'object' && value !== null) {
      Object.assign(result, flatten(value as Record<string, unknown>, fullKey));
    }
  }
  return result;
}

const FLATTENED: Record<Locale, Record<string, string>> = {
  en: flatten(RESOURCES.en),
  ar: flatten(RESOURCES.ar),
};

export interface TranslateOptions {
  count?: number;
  [interpolationKey: string]: string | number | undefined;
}

function resolvePluralKey(key: string, count: number | undefined, resources: Record<string, string>): string {
  if (count === undefined) return key;
  const suffix = count === 1 ? '_one' : '_other';
  const pluralKey = `${key}${suffix}`;
  return pluralKey in resources ? pluralKey : key;
}

function interpolate(template: string, options?: TranslateOptions): string {
  if (!options) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, token) => {
    const value = options[token];
    return value !== undefined ? String(value) : `{{${token}}}`;
  });
}

/**
 * The localization engine's public translate function. Fallback
 * strategy: requested locale -> the default locale (`FALLBACK_LOCALE`,
 * which IS `DEFAULT_LOCALE` \u2014 see A3 there) -> the raw key itself
 * (never a blank string \u2014 a missing translation should be visibly
 * wrong, not silently empty). This is the same chain the two Flutter
 * engines implement, which is what their headers already claim.
 *
 * Pluralization support: a Sprint-8-scoped simple two-form system
 * (`_one` / `_other` suffix keys, falling back to the base key if
 * neither exists) \u2014 not full CLDR plural-category support (Arabic has
 * six grammatical plural forms; this covers the common "1 vs many"
 * case only, flagged as a real simplification, not hidden).
 */
export function translate(locale: Locale, key: string, options?: TranslateOptions): string {
  const resources = FLATTENED[locale] ?? FLATTENED[FALLBACK_LOCALE];
  const resolvedKey = resolvePluralKey(key, options?.count, resources);

  const template =
    resources[resolvedKey] ??
    FLATTENED[FALLBACK_LOCALE][resolvedKey] ??
    key;

  return interpolate(template, options);
}

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

/** Locale persistence \u2014 localStorage today (matches this project's
 * existing Dashboard pattern, e.g. tokenStorage.ts's sessionStorage use
 * for the refresh token). Syncing to `User.locale` (already a real
 * backend field, ProfileService.updateProfile) on login is a real
 * follow-up, not done here \u2014 this function is intentionally
 * synchronous/local-only. */
export function getPersistedLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  return SUPPORTED_LOCALES.includes(stored as Locale) ? (stored as Locale) : DEFAULT_LOCALE;
}

export function persistLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}
