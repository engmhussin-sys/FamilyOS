import { useTranslation } from './LocaleProvider';
import { SUPPORTED_LOCALES, type Locale } from './localizationEngine';

const LOCALE_LABELS: Record<Locale, string> = { en: 'English', ar: 'العربية' };

export function LanguageSwitcher() {
  const { locale, setLocale } = useTranslation();

  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="rounded-card border border-sand-200 bg-white px-2 py-1 text-sm text-ink"
      aria-label="Language"
    >
      {SUPPORTED_LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
