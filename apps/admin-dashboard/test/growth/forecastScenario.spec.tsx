import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScenarioSwitcher } from '@/features/growth/components/ScenarioSwitcher';
import { AssumptionsEditor, validateAssumptions } from '@/features/growth/components/AssumptionsEditor';
import { QuarterlyTable } from '@/features/growth/pages/ForecastPage';
import { QuarterlyChart } from '@/features/growth/components/viz/QuarterlyChart';
import { ChartFrame } from '@/features/growth/components/viz/ChartFrame';
import type { ForecastAssumptions, ForecastScenarioName, QuarterlyRow } from '@/features/growth/api/types';
import { renderWithLocale } from './renderWithLocale';

const BASE_ASSUMPTIONS: ForecastAssumptions = {
  monthlyAcquisition: 10000,
  conversionRate: 0.25,
  paidConversionRate: 0.4,
  churnRate: 0.06,
  arpuMinor: 17900,
  cacMinor: 35000,
  retentionD30: 0.35,
};

const ROWS: QuarterlyRow[] = [
  { countryCode: 'EG', year: 2026, quarter: 1, metric: 'PAID_USERS', target: 400, actual: 380, forecast: 420, attainment: 0.95, currencyCode: null },
  { countryCode: 'EG', year: 2026, quarter: 2, metric: 'PAID_USERS', target: 700, actual: 640, forecast: 780, attainment: 0.914, currencyCode: null },
  { countryCode: 'EG', year: 2026, quarter: 3, metric: 'PAID_USERS', target: 1000, actual: 310, forecast: 1160, attainment: 0.31, currencyCode: null },
  // Q4 has not opened: actual is null (NOT zero) and nobody committed to a
  // target, so target is null too — and a target is never inferred from a
  // forecast, which is exactly what this row proves.
  { countryCode: 'EG', year: 2026, quarter: 4, metric: 'PAID_USERS', target: null, actual: null, forecast: 1600, attainment: null, currencyCode: null },
];

function ScenarioHarness({ available }: { available: readonly ForecastScenarioName[] }) {
  const [scenario, setScenario] = useState<ForecastScenarioName>('BASE');
  return (
    <div>
      <ScenarioSwitcher scenario={scenario} onChange={setScenario} available={available} />
      <output data-testid="selected">{scenario}</output>
    </div>
  );
}

describe('forecast scenario switching', () => {
  it('offers all three scenarios so none can hide behind a collapsed control', async () => {
    renderWithLocale(<ScenarioHarness available={['CONSERVATIVE', 'BASE', 'AGGRESSIVE']} />, 'ar');
    expect(screen.getByRole('radio', { name: 'متحفّظ' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'أساسي' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'طموح' })).toBeInTheDocument();
  });

  it('switches the selected scenario on click and moves aria-checked with it', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ScenarioHarness available={['CONSERVATIVE', 'BASE', 'AGGRESSIVE']} />, 'ar');

    expect(screen.getByRole('radio', { name: 'أساسي' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'طموح' }));

    expect(screen.getByTestId('selected')).toHaveTextContent('AGGRESSIVE');
    expect(screen.getByRole('radio', { name: 'طموح' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'أساسي' })).toHaveAttribute('aria-checked', 'false');
  });

  it('disables — rather than hides — a scenario the backend has not saved, so its absence is visible', async () => {
    const user = userEvent.setup();
    renderWithLocale(<ScenarioHarness available={['BASE']} />, 'ar');

    const aggressive = screen.getByRole('radio', { name: 'طموح' });
    expect(aggressive).toBeDisabled();
    await user.click(aggressive);
    expect(screen.getByTestId('selected')).toHaveTextContent('BASE');
  });
});

describe('AssumptionsEditor', () => {
  it('renders all seven editable assumptions', () => {
    renderWithLocale(<AssumptionsEditor assumptions={BASE_ASSUMPTIONS} onSave={() => {}} />, 'ar');
    expect(screen.getByLabelText('الاكتساب الشهري')).toBeInTheDocument();
    expect(screen.getByLabelText('معدل التحويل')).toBeInTheDocument();
    expect(screen.getByLabelText('معدل التسرّب')).toBeInTheDocument();
    expect(screen.getByLabelText('الاحتفاظ D30')).toBeInTheDocument();
  });

  it('rejects a rate outside [0,1] before a round trip, in the operator’s language', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithLocale(<AssumptionsEditor assumptions={BASE_ASSUMPTIONS} onSave={onSave} />, 'ar');

    const churn = screen.getByLabelText('معدل التسرّب');
    await user.clear(churn);
    await user.type(churn, '1.4');

    expect(screen.getByText('المعدل يجب أن يقع بين 0 و 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ السيناريو' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a valid edit and hands back the whole assumption set', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithLocale(<AssumptionsEditor assumptions={BASE_ASSUMPTIONS} onSave={onSave} />, 'ar');

    const churn = screen.getByLabelText('معدل التسرّب');
    await user.clear(churn);
    await user.type(churn, '0.08');
    await user.click(screen.getByRole('button', { name: 'حفظ السيناريو' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ churnRate: 0.08, monthlyAcquisition: 10000 }));
  });

  it('validateAssumptions flags exactly the four rate fields', () => {
    expect(validateAssumptions(BASE_ASSUMPTIONS)).toEqual([]);
    expect(validateAssumptions({ ...BASE_ASSUMPTIONS, conversionRate: 2 })).toEqual(['conversionRate']);
    // A large ARPU in minor units is NOT a rate and must not be flagged.
    expect(validateAssumptions({ ...BASE_ASSUMPTIONS, arpuMinor: 999999 })).toEqual([]);
  });
});

describe('FORECAST, TARGET and ACTUAL are separated by more than a legend', () => {
  function renderQuarterly() {
    return renderWithLocale(
      <ChartFrame mode="light" title="quarterly" table={<QuarterlyTable rows={ROWS} format={(v) => String(v ?? '—')} />}>
        {(patterns) => (
          <QuarterlyChart rows={ROWS} mode="light" patterns={patterns} formatValue={(v) => String(v ?? '—')} isRtl />
        )}
      </ChartFrame>,
      'ar',
    );
  }

  it('draws ACTUAL as the only solid fill and FORECAST as a hatch pattern', () => {
    const { container } = renderQuarterly();
    const solid = container.querySelectorAll('path[fill="#00846F"]');
    const hatched = container.querySelectorAll('path[fill^="url(#"]');
    expect(solid.length).toBe(3); // Q1–Q3 have an actual; Q4 has not opened.
    expect(hatched.length).toBe(4); // all four quarters carry a forecast
  });

  it('draws TARGET as a dashed rule, never as a third bar', () => {
    const { container } = renderQuarterly();
    const dashed = container.querySelectorAll('line[stroke-dasharray]');
    expect(dashed.length).toBe(3); // Q4 has no target
    // And no target is ever rendered as a filled column.
    expect(container.querySelectorAll('rect[fill="#4E463C"]').length).toBe(0);
  });

  it('gives FORECAST a dashed outline as well as its hatch, so greyscale still separates it', () => {
    const { container } = renderQuarterly();
    const forecastMarks = container.querySelectorAll('path[stroke-dasharray]');
    expect(forecastMarks.length).toBe(4);
  });

  it('prints a missing target as "nobody committed", never as zero and never as the forecast', async () => {
    const user = userEvent.setup();
    renderQuarterly();
    // Switch to the table twin — the relief channel the palette's contrast
    // WARN obligates, where the three columns are explicit.
    await user.click(screen.getByRole('button', { name: 'عرض الجدول' }));

    const table = screen.getByRole('table');
    expect(within(table).getByText('لم يلتزم أحد بهدف')).toBeInTheDocument();
    expect(within(table).queryByText('0')).not.toBeInTheDocument();
  });

  it('labels every row of the table with its provenance badge', async () => {
    const user = userEvent.setup();
    renderQuarterly();
    await user.click(screen.getByRole('button', { name: 'عرض الجدول' }));

    // Once in each column header, then once on every row — so a reader
    // scanning a single row never has to look back up to know which of the
    // three numbers they are reading.
    const body = screen.getAllByRole('rowgroup')[1];
    expect(within(body).getAllByText('مقيس').length).toBe(ROWS.length);
    expect(within(body).getAllByText('هدف').length).toBe(ROWS.length);
    expect(within(body).getAllByText('توقّع').length).toBe(ROWS.length);

    const head = screen.getAllByRole('rowgroup')[0];
    expect(within(head).getByText('مقيس')).toBeInTheDocument();
    expect(within(head).getByText('هدف')).toBeInTheDocument();
    expect(within(head).getByText('توقّع')).toBeInTheDocument();
  });
});
