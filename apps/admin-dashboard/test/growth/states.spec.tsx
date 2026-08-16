import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AsyncBoundary,
  EmptyBlock,
  ErrorBlock,
  GapBlock,
  LoadingBlock,
} from '@/features/growth/components/AsyncState';
import { GAPS } from '@/features/growth/api/adapters';
import { ApiError } from '@/shared/lib/httpClient';
import { renderWithLocale } from './renderWithLocale';

/**
 * Every view has four states and this file proves each of them renders
 * something an operator can act on — plus the fifth this dashboard needed,
 * a number that has no endpoint at all.
 */
describe('loading / empty / error / gap states', () => {
  it('announces loading politely rather than freezing the panel', () => {
    renderWithLocale(<LoadingBlock />, 'ar');
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    // The shipped string is the more specific «جارٍ تحميل البيانات…»; this
    // assertion had been written against an assumed shorter wording.
    expect(status).toHaveTextContent('جارٍ تحميل البيانات…');
  });

  it('an empty panel says "no data yet" and explicitly denies being a zero', () => {
    renderWithLocale(<EmptyBlock />, 'ar');
    expect(screen.getByText('لا توجد بيانات بعد')).toBeInTheDocument();
    expect(screen.getByText('لم يُسجَّل أي صف في هذه الفترة. هذا ليس صفرًا.')).toBeInTheDocument();
  });

  describe('the B3 error envelope', () => {
    const error = new ApiError(
      'Conversion query failed.',
      500,
      'GROWTH_QUERY_FAILED',
      'تعذّر تنفيذ استعلام التحويل.',
      'req-abc-123',
      { countryCode: 'EG' },
    );

    it('shows messageAr to an Arabic-reading operator', () => {
      renderWithLocale(<ErrorBlock error={error} />, 'ar');
      expect(screen.getByText('تعذّر تنفيذ استعلام التحويل.')).toBeInTheDocument();
      expect(screen.queryByText('Conversion query failed.')).not.toBeInTheDocument();
    });

    it('falls back to the English message under the English locale', () => {
      renderWithLocale(<ErrorBlock error={error} />, 'en');
      expect(screen.getByText('Conversion query failed.')).toBeInTheDocument();
    });

    it('quotes the requestId verbatim — it is what a support ticket is resolved by', () => {
      renderWithLocale(<ErrorBlock error={error} />, 'ar');
      expect(screen.getByText(/req-abc-123/)).toBeInTheDocument();
    });

    it('shows the machine-readable code alongside the prose, so branching never keys on prose', () => {
      renderWithLocale(<ErrorBlock error={error} />, 'ar');
      expect(screen.getByText('GROWTH_QUERY_FAILED')).toBeInTheDocument();
    });

    it('degrades to a plain message for a non-envelope failure (a proxy 502, a dropped socket)', () => {
      renderWithLocale(<ErrorBlock error={new Error('Failed to fetch')} />, 'ar');
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
    });

    it('offers a retry that actually calls back', async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      renderWithLocale(<ErrorBlock error={error} onRetry={onRetry} />, 'ar');
      await user.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      expect(onRetry).toHaveBeenCalledOnce();
    });
  });

  describe('GapBlock', () => {
    it('names the missing endpoint instead of showing a zero', () => {
      renderWithLocale(<GapBlock gap={GAPS.productAiMetrics} />, 'ar');
      expect(screen.getByText('لا يوجد endpoint لهذا الرقم بعد')).toBeInTheDocument();
      expect(screen.getByText('GET /admin/growth/product?countryCode&from&to')).toBeInTheDocument();
      expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('renders the proposed contract left-to-right even inside an RTL page', () => {
      renderWithLocale(<GapBlock gap={GAPS.refunds} />, 'ar');
      expect(screen.getByText(GAPS.refunds.proposedEndpoint)).toHaveAttribute('dir', 'ltr');
    });
  });

  describe('AsyncBoundary picks exactly one state', () => {
    it('prefers loading over everything', () => {
      renderWithLocale(
        <AsyncBoundary isLoading error={new Error('x')} isEmpty>
          <p>content</p>
        </AsyncBoundary>,
        'ar',
      );
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.queryByText('content')).not.toBeInTheDocument();
    });

    it('prefers an error over an empty state — an unknown result is not an empty one', () => {
      renderWithLocale(
        <AsyncBoundary isLoading={false} error={new Error('boom')} isEmpty>
          <p>content</p>
        </AsyncBoundary>,
        'ar',
      );
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('renders children when there is data', () => {
      renderWithLocale(
        <AsyncBoundary isLoading={false} error={null} isEmpty={false}>
          <p>content</p>
        </AsyncBoundary>,
        'ar',
      );
      expect(screen.getByText('content')).toBeInTheDocument();
    });
  });
});
