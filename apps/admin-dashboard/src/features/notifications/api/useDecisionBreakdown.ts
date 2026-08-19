import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchDecisionBreakdown,
  type DecisionAudience,
  type DecisionBreakdown,
} from './decisionBreakdownApi';
import type { DateRange } from '../../growth/lib/range';

/**
 * The key is structured like the growth surface's — `['notifications',
 * <resource>, ...scope]` — so a window or audience change invalidates exactly
 * this panel and nothing else, and a refetch holds the previous render rather
 * than flashing a skeleton over a number the operator was reading.
 */
export function useDecisionBreakdown(
  range: DateRange,
  audience: DecisionAudience | 'ALL',
): UseQueryResult<DecisionBreakdown> {
  return useQuery({
    queryKey: ['notifications', 'decision-breakdown', range.from, range.to, audience],
    queryFn: () =>
      fetchDecisionBreakdown({
        from: range.from,
        to: range.to,
        // `ALL` is the ABSENCE of the filter, not a value. The route validates
        // `audience` against `PARENT | CHILD` and answers 400 to anything
        // else, so sending `ALL` would turn "no filter" into an error.
        audience: audience === 'ALL' ? undefined : audience,
      }),
  });
}
