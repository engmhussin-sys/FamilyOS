import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { KpiCard } from '@/features/growth/components/KpiCard';
import { CurrencyWithoutCountryError, NO_DATA } from '@/features/growth/lib/format';
import type { KpiValue } from '@/features/growth/api/types';
import { renderWithLocale } from './renderWithLocale';

const dau: KpiValue = { kpi: 'DAU', provenance: 'ACTUAL', value: 1200, currencyCode: null, kind: 'COUNT' };
const arppu: KpiValue = { kpi: 'ARPPU', provenance: 'ACTUAL', value: 15702, currencyCode: 'EGP', kind: 'MONEY_MINOR' };
const youngCohortD90: KpiValue = {
  kpi: 'RETENTION_D90',
  provenance: 'ACTUAL',
  value: null,
  currencyCode: null,
  kind: 'RATE',
};
const ltv: KpiValue = { kpi: 'LTV', provenance: 'FORECAST', value: 280100, currencyCode: 'EGP', kind: 'MONEY_MINOR' };

describe('KpiCard', () => {
  it('renders the KPI’s Arabic name from the localization engine, not a hardcoded string', () => {
    renderWithLocale(<KpiCard kpi={dau} countryScope="EG" />, 'ar');
    // If `growth.kpi.DAU` were missing, the engine would render the raw key
    // and this assertion would fail — the test doubles as an i18n coverage check.
    expect(screen.getByText('المستخدمون النشطون يوميًا')).toBeInTheDocument();
    expect(screen.queryByText('growth.kpi.DAU')).not.toBeInTheDocument();
  });

  it('renders a measured value with the ACTUAL badge', () => {
    renderWithLocale(<KpiCard kpi={dau} countryScope="EG" />, 'ar');
    expect(screen.getByText('مقيس')).toBeInTheDocument();
  });

  describe('an empty metric reads "no data yet", never zero', () => {
    it('renders the em dash for a null value', () => {
      renderWithLocale(<KpiCard kpi={youngCohortD90} countryScope="EG" />, 'ar');
      expect(screen.getByText(NO_DATA)).toBeInTheDocument();
      // The failure this guards: a 45-day-old cohort has no D90 number, and
      // showing 0% invents a catastrophic retention figure out of a cohort
      // that is simply too young to have one.
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
      expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    });

    it('explains the absence in words as well as a glyph', () => {
      renderWithLocale(<KpiCard kpi={youngCohortD90} countryScope="EG" />, 'ar');
      expect(screen.getByText('لم يُسجَّل أي صف في هذه الفترة. هذا ليس صفرًا.')).toBeInTheDocument();
    });

    it('renders the no-data state when the KPI row is absent from the snapshot entirely', () => {
      renderWithLocale(<KpiCard kpi={undefined} countryScope="EG" />, 'ar');
      expect(screen.getByText(NO_DATA)).toBeInTheDocument();
    });
  });

  describe('money always carries its market', () => {
    it('renders an EGP figure under an Egyptian scope', () => {
      renderWithLocale(<KpiCard kpi={arppu} countryScope="EG" contextLabel="مصر · EGP" />, 'ar');
      expect(screen.getByText('مصر · EGP')).toBeInTheDocument();
    });

    /**
     * The component-level half of the currency guard. A KPI card is the most
     * likely place for a money figure to escape its market — it is small,
     * reusable and gets dropped into new layouts — so the refusal is proven
     * at the component boundary, not only in the formatter.
     */
    it('REFUSES to render a money KPI on a screen with no country context', () => {
      // React logs the boundary-less throw; that noise is expected here and
      // is silenced so a real error in another test stays visible.
      const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => renderWithLocale(<KpiCard kpi={arppu} countryScope="**" />, 'ar')).toThrow(
          CurrencyWithoutCountryError,
        );
      } finally {
        silenced.mockRestore();
      }
    });
  });

  describe('an assumption never reads as a fact', () => {
    it('badges a FORECAST value as a forecast', () => {
      renderWithLocale(<KpiCard kpi={ltv} countryScope="EG" />, 'ar');
      expect(screen.getByText('توقّع')).toBeInTheDocument();
      expect(screen.queryByText('مقيس')).not.toBeInTheDocument();
    });

    it('styles the FORECAST value differently from an ACTUAL one — not by badge alone', () => {
      const { unmount } = renderWithLocale(<KpiCard kpi={ltv} countryScope="EG" />, 'ar');
      const forecastValue = screen.getByText((_, element) => element?.tagName === 'P' && element.className.includes('italic'));
      expect(forecastValue).toBeInTheDocument();
      unmount();

      renderWithLocale(<KpiCard kpi={arppu} countryScope="EG" />, 'ar');
      expect(
        screen.queryByText((_, element) => element?.tagName === 'P' && element.className.includes('italic')),
      ).toBeNull();
    });

    it('says out loud that LTV is structurally a forecast, because it multiplies by an assumed margin', () => {
      renderWithLocale(<KpiCard kpi={ltv} countryScope="EG" />, 'ar');
      expect(
        screen.getByText('هذا المؤشر توقّع دائمًا: يضرب رقمًا مقيسًا في هامش ربح مفترض.'),
      ).toBeInTheDocument();
    });
  });

  describe('locale', () => {
    it('renders the English name under the English locale', () => {
      renderWithLocale(<KpiCard kpi={dau} countryScope="EG" />, 'en');
      expect(screen.getByText('Daily active users')).toBeInTheDocument();
      expect(screen.getByText('1,200')).toBeInTheDocument();
    });
  });
});
