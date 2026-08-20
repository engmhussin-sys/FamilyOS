import { adminGet, adminQuery as query } from '../../../shared/lib/adminHttp';

/**
 * `GET /system/notifications/decision-breakdown`
 * (`apps/backend/src/modules/notifications/presentation/controllers/
 *   notification-operations.controller.ts`).
 *
 * THE SAME OPERATOR KEY AS EVERY OTHER PLATFORM ROUTE. It goes through
 * `adminHttp`, which reads the key out of `adminKeyStore` at the instant of
 * the fetch and discards it on a 401/403. This module never sees the secret,
 * never stores one and never adds a header of its own — there is exactly one
 * door and this is not a second one.
 *
 * Transcribed from `DecisionBreakdownReport`
 * (`src/modules/notifications/application/ports/
 *   notification-decision.repository.port.ts`), read from the port, not from
 * a document. Nothing here is anticipated: every field exists in the
 * backend's own response type.
 *
 * WHAT THE ENDPOINT DOES NOT RETURN, and therefore what this client can never
 * render: a family id, a child id, a source event id, a title or a body. The
 * buckets are closed-vocabulary names and business dates.
 */

/** One slice of the ledger and its six counts. `bucket` is the VALUE of the
 * dimension: `PARENT`, `DOMAIN_EVENT`, `rule-based`, `2025-11-20`,
 * `REWARD_GRANTED`. */
export interface DecisionBucket {
  bucket: string;
  total: number;
  /** What the ENGINE decided. */
  decidedSend: number;
  decidedDefer: number;
  decidedSuppress: number;
  /** What the PIPELINE then did. The two disagreeing is the useful row. */
  delivered: number;
  deliveryErrors: number;
}

export interface DecisionBreakdown {
  /** The window the server RESOLVED, which is not always the one asked for —
   * both are absent by default and the server fills in the last 30 days. The
   * page prints these rather than its own request, so it cannot mislabel its
   * own numbers. */
  fromBusinessDate: string;
  toBusinessDate: string;
  totals: DecisionBucket;
  byAudience: DecisionBucket[];
  byNotificationType: DecisionBucket[];
  bySource: DecisionBucket[];
  byProvenance: DecisionBucket[];
  byDate: DecisionBucket[];
  topCauses: DecisionBucket[];
  limits: {
    topLimit: number;
    maxRangeDays: number;
    /** TRUE means the list was cut at `topLimit` and the remainder was never
     * returned. It is the reason this page has an unmeasured row at all. */
    typesTruncated: boolean;
    causesTruncated: boolean;
  };
}

export type DecisionAudience = 'PARENT' | 'CHILD';

export function fetchDecisionBreakdown(args: {
  from: string;
  to: string;
  audience?: DecisionAudience;
}): Promise<DecisionBreakdown> {
  return adminGet<DecisionBreakdown>(
    `/system/notifications/decision-breakdown${query({
      // The route runs `isBusinessDate` and answers 400 to anything that is
      // not `YYYY-MM-DD` — the same contract `fetchNotificationAnalytics`
      // narrows for, and narrowed here for the same reason: one place, so no
      // caller has to remember.
      from: businessDate(args.from),
      to: businessDate(args.to),
      audience: args.audience,
    })}`,
  );
}

function businessDate(instant: string): string {
  return instant.slice(0, 10);
}
