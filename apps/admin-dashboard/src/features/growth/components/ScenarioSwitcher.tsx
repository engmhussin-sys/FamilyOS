import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { FORECAST_SCENARIOS, type ForecastScenarioName } from '../api/types';

/**
 * Conservative / Base / Aggressive.
 *
 * Rendered as a radio group rather than a `<select>` so all three are always
 * visible: a collapsed control lets an aggressive scenario sit on screen for
 * a whole meeting without anyone noticing which one is selected.
 */
export function ScenarioSwitcher({
  scenario,
  onChange,
  available,
}: {
  scenario: ForecastScenarioName;
  onChange: (scenario: ForecastScenarioName) => void;
  /** Scenarios the backend actually returned. A scenario nobody has saved
   * is shown disabled rather than hidden, so its absence is visible. */
  available: readonly ForecastScenarioName[];
}) {
  const { t } = useTranslation();

  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{t('growth.forecast.scenario')}</legend>
      <span className="text-xs font-medium text-ink-soft">{t('growth.forecast.scenario')}</span>
      {FORECAST_SCENARIOS.map((name) => {
        const isAvailable = available.includes(name);
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={scenario === name}
            disabled={!isAvailable}
            onClick={() => onChange(name)}
            className={`rounded-card px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              scenario === name ? 'bg-amber-500 text-ink' : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
            }`}
          >
            {t(`growth.forecast.${name}`)}
          </button>
        );
      })}
    </fieldset>
  );
}
