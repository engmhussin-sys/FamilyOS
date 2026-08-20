import { useState } from 'react';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { Button } from '../../../shared/components/Button';
import { Input } from '../../../shared/components/Input';
import {
  ASSUMPTION_KEYS,
  RATE_ASSUMPTION_KEYS,
  type ForecastAssumptions,
} from '../api/types';

/**
 * The seven editable assumptions.
 *
 * They are returned alongside every number derived from them, so this panel
 * sits directly above the forecast it produces — a reader who disagrees
 * with the projection can disagree with the *inputs* rather than argue with
 * an output they cannot inspect.
 *
 * The four rates are validated in [0,1] here as well as at the API (which
 * rejects with 400) and again by a CHECK constraint in PostgreSQL. Three
 * layers is not redundancy for its own sake: the client one exists so an
 * operator gets the message in their language before a round trip, and the
 * database one exists because the other two are code.
 */

export function validateAssumptions(assumptions: ForecastAssumptions): (keyof ForecastAssumptions)[] {
  return RATE_ASSUMPTION_KEYS.filter((key) => {
    const value = assumptions[key];
    return !Number.isFinite(value) || value < 0 || value > 1;
  });
}

interface AssumptionsEditorProps {
  assumptions: ForecastAssumptions;
  onSave: (assumptions: ForecastAssumptions) => void;
  isSaving?: boolean;
  readOnly?: boolean;
}

export function AssumptionsEditor({ assumptions, onSave, isSaving, readOnly }: AssumptionsEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ForecastAssumptions>(assumptions);
  const [touched, setTouched] = useState(false);

  const invalid = validateAssumptions(draft);
  const current = touched ? draft : assumptions;

  return (
    <section className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet">
      <header className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base text-ink">{t('growth.forecast.assumptions')}</h3>
      </header>
      <p className="mb-4 max-w-3xl text-xs text-ink-soft">{t('growth.forecast.assumptionsHint')}</p>

      {/* Reuses the Phase-B `Input`, which already owns label/hint/error
          wiring and `aria-describedby` — a second labelled input in this
          codebase would be a second set of accessibility bugs. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ASSUMPTION_KEYS.map((key) => (
          <Input
            key={key}
            label={t(`growth.forecast.assumption.${key}`)}
            type="number"
            step={RATE_ASSUMPTION_KEYS.includes(key) ? '0.01' : '1'}
            value={String(current[key])}
            disabled={readOnly}
            error={invalid.includes(key) ? t('growth.forecast.rateOutOfRange') : undefined}
            onChange={(event) => {
              setTouched(true);
              setDraft((prev) => ({ ...prev, [key]: Number(event.target.value) }));
            }}
          />
        ))}
      </div>

      <p className="mt-4 text-xs text-ink-soft">{t('growth.forecast.modelNote')}</p>

      {!readOnly && (
        <Button
          className="mt-4"
          disabled={invalid.length > 0 || !touched}
          isLoading={isSaving}
          onClick={() => onSave(draft)}
        >
          {t('growth.forecast.saveScenario')}
        </Button>
      )}
    </section>
  );
}
