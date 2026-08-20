import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { COUNTRY_CODES, PLATFORM_SCOPE, type CountryScope } from '../api/types';
import { RANGE_PRESETS, type RangePreset } from '../lib/range';
import { COUNTRY_CURRENCY } from '../lib/format';

/**
 * ONE filter row, above everything it scopes. Never a filter inside a chart
 * card and never a per-chart control: every panel below re-renders against
 * the same slice, so two numbers on the same screen are always about the
 * same window.
 */

interface FilterBarProps {
  country: CountryScope;
  onCountryChange: (country: CountryScope) => void;
  range: RangePreset;
  onRangeChange: (range: RangePreset) => void;
  /** The platform scope carries no money, so views that are entirely
   * financial hide it rather than offering a choice that returns nulls. */
  allowPlatformScope?: boolean;
}

export function FilterBar({
  country,
  onCountryChange,
  range,
  onRangeChange,
  allowPlatformScope = true,
}: FilterBarProps) {
  const { t } = useTranslation();

  const scopes: CountryScope[] = allowPlatformScope ? [...COUNTRY_CODES, PLATFORM_SCOPE] : [...COUNTRY_CODES];

  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-sand-200 bg-white px-4 py-3 shadow-quiet">
      <fieldset className="flex items-center gap-2">
        <legend className="sr-only">{t('growth.filter.country')}</legend>
        <span className="text-xs font-medium text-ink-soft">{t('growth.filter.country')}</span>
        {scopes.map((scope) => (
          <button
            key={scope}
            type="button"
            aria-pressed={country === scope}
            onClick={() => onCountryChange(scope)}
            className={`rounded-card px-3 py-1.5 text-xs font-medium transition-colors ${
              country === scope ? 'bg-guardian-900 text-sand-50' : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
            }`}
          >
            {scope === PLATFORM_SCOPE
              ? t('growth.country.platform')
              : /* A market chip always carries its currency, so a figure
                   underneath can never be read against the wrong one. */
                `${t(`growth.country.${scope}`)} · ${COUNTRY_CURRENCY[scope]}`}
          </button>
        ))}
      </fieldset>

      <fieldset className="flex items-center gap-2">
        <legend className="sr-only">{t('growth.filter.range')}</legend>
        <span className="text-xs font-medium text-ink-soft">{t('growth.filter.range')}</span>
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={range === preset}
            onClick={() => onRangeChange(preset)}
            className={`rounded-card px-3 py-1.5 text-xs font-medium transition-colors ${
              range === preset ? 'bg-guardian-900 text-sand-50' : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
            }`}
          >
            {t(`growth.filter.${preset}`)}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** Page heading shared by every growth view, so hierarchy is identical
 * across them: title, one sentence of what it answers, then the filter row. */
export function GrowthPageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="mb-5">
      <h2 className="font-display text-2xl text-ink">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-soft">{subtitle}</p>
    </header>
  );
}
