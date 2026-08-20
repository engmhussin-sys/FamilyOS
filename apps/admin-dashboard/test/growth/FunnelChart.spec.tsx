import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { FunnelChart, roundedBar } from '@/features/growth/components/viz/FunnelChart';
import { ChartFrame } from '@/features/growth/components/viz/ChartFrame';
import type { FunnelStepRow } from '@/features/growth/api/types';
import { renderWithLocale } from './renderWithLocale';

/**
 * The funnel's contract with the reader, tested at the mark level:
 *
 *  - a step measured from a domain table and a step reported by an ad
 *    platform must NOT be drawn the same way,
 *  - the activation step must be highlighted, not merely present,
 *  - a null step conversion must read as absence, not as 0%.
 */

const STEPS: FunnelStepRow[] = [
  { step: 'IMPRESSION', count: 1200000, source: 'EXTERNAL_REPORTED', stepConversion: null, fromMeasurableTop: null },
  { step: 'VISIT', count: 48000, source: 'EXTERNAL_REPORTED', stepConversion: 0.04, fromMeasurableTop: null },
  { step: 'INSTALL', count: 9600, source: 'ANALYTICS_EVENT', stepConversion: 0.2, fromMeasurableTop: 1 },
  { step: 'REGISTRATION', count: 3100, source: 'DOMAIN_TABLE', stepConversion: 0.3229, fromMeasurableTop: 0.3229 },
  { step: 'FAMILY_CREATED', count: 3050, source: 'DOMAIN_TABLE', stepConversion: 0.9839, fromMeasurableTop: 0.3177 },
  { step: 'CHILD_ADDED', count: 2800, source: 'DOMAIN_TABLE', stepConversion: 0.918, fromMeasurableTop: 0.2917 },
  { step: 'FIRST_GOAL', count: 960, source: 'DOMAIN_TABLE', stepConversion: 0.3429, fromMeasurableTop: 0.1 },
  { step: 'FIRST_REWARD', count: 940, source: 'DOMAIN_TABLE', stepConversion: 0.9792, fromMeasurableTop: 0.0979 },
  { step: 'TRIAL', count: 620, source: 'DOMAIN_TABLE', stepConversion: 0.6596, fromMeasurableTop: 0.0646 },
  { step: 'PAID', count: 310, source: 'DOMAIN_TABLE', stepConversion: 0.5, fromMeasurableTop: 0.0323 },
  { step: 'RENEWAL', count: 0, source: 'DOMAIN_TABLE', stepConversion: 0, fromMeasurableTop: 0 },
];

function renderFunnel(steps: FunnelStepRow[] = STEPS, isRtl = true) {
  return renderWithLocale(
    <ChartFrame mode="light" title="funnel" table={<table />}>
      {(patterns) => (
        <FunnelChart steps={steps} mode="light" patterns={patterns} activationStep="FIRST_GOAL" isRtl={isRtl} />
      )}
    </ChartFrame>,
    'ar',
  );
}

describe('FunnelChart', () => {
  it('draws every one of the eleven steps', () => {
    const { container } = renderFunnel();
    const bars = container.querySelectorAll('path[d]');
    expect(bars.length).toBeGreaterThanOrEqual(STEPS.length - 1); // RENEWAL is 0-length
  });

  it('labels each step in Arabic from the localization engine', () => {
    renderFunnel();
    expect(screen.getAllByText(/تسجيل/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/مدفوع/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/growth\.funnel\.step/)).not.toBeInTheDocument();
  });

  describe('an externally reported step is not drawn like a measured one', () => {
    it('fills EXTERNAL_REPORTED steps with a hatch pattern rather than a flat colour', () => {
      const { container } = renderFunnel();
      const hatched = Array.from(container.querySelectorAll('path[fill^="url(#"]'));
      // IMPRESSION and VISIT are both EXTERNAL_REPORTED.
      expect(hatched.length).toBe(2);
    });

    it('fills DOMAIN_TABLE steps with the solid series colour', () => {
      const { container } = renderFunnel();
      const solid = Array.from(container.querySelectorAll('path[fill="#00846F"]'));
      expect(solid.length).toBeGreaterThan(0);
    });

    it('gives each source its own glyph, so the distinction survives greyscale', () => {
      renderFunnel();
      // ◌ = externally reported, ◐ = analytics event, ● = domain table.
      expect(screen.getByText(/◌ .*ظهور/)).toBeInTheDocument();
      expect(screen.getByText(/◐ .*تثبيت/)).toBeInTheDocument();
      expect(screen.getByText(/● .*تسجيل$/)).toBeInTheDocument();
    });
  });

  it('highlights the activation step rather than listing it as step seven of eleven', () => {
    const { container } = renderFunnel();
    // The highlight band is the only status-coloured rect on the plot.
    const highlight = container.querySelectorAll('rect[fill="#2E7D4F"]');
    expect(highlight.length).toBe(1);
  });

  it('renders a null step conversion as an em dash, never as 0%', () => {
    renderFunnel();
    // IMPRESSION has no step conversion — it is the top of the funnel.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the absolute drop-off beside the percentage, so a 40% drop is not read blind', () => {
    renderFunnel();
    // Every step after the first prints a signed drop-off beside its
    // conversion — ten of them for eleven steps.
    expect(screen.getAllByText(/−/).length).toBe(STEPS.length - 1);
  });

  describe('RTL', () => {
    it('grows bars from the right in Arabic and from the left in English', () => {
      const { container: rtl, unmount } = renderFunnel(STEPS, true);
      const rtlFirstBar = rtl.querySelector('path[d]')?.getAttribute('d') ?? '';
      unmount();

      const { container: ltr } = renderFunnel(STEPS, false);
      const ltrFirstBar = ltr.querySelector('path[d]')?.getAttribute('d') ?? '';

      expect(rtlFirstBar).not.toBe(ltrFirstBar);
    });
  });
});

describe('roundedBar', () => {
  it('rounds only the data-end and leaves the baseline end square', () => {
    const d = roundedBar(0, 0, 100, 20, 4, 'end');
    // Two quadratic curves at the growing end, none at the baseline.
    expect(d.match(/Q/g)?.length).toBe(2);
    expect(d.startsWith('M 0 0')).toBe(true);
  });

  it('mirrors the rounded end for an RTL bar', () => {
    expect(roundedBar(0, 0, 100, 20, 4, 'start')).not.toBe(roundedBar(0, 0, 100, 20, 4, 'end'));
  });

  it('emits nothing for a zero-length bar rather than a degenerate path', () => {
    expect(roundedBar(0, 0, 0, 20, 4, 'end')).toBe('');
  });
});
