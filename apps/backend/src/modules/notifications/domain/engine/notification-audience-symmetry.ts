/**
 * ============================================================================
 * THE INVARIANT: THE PARENT MUST NOT LEARN OF SOMETHING THE CHILD NEVER LEARNS
 * OF.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS, AND IT IS A MEASUREMENT RATHER THAN A PRINCIPLE.
 *
 * Read out of `notification_decisions` against a real PostgreSQL, one child,
 * one afternoon, `maxPerHour = 3`:
 *
 *   BADGE_EARNED         aud=CHILD  decision=SUPPRESS reason=SCORE_BELOW_FLOOR score=17
 *   BADGE_EARNED_PARENT  aud=PARENT decision=SEND     reason=SCORE_IN_DEFER_BAND score=25
 *
 * SAME `source_event_id`. SAME badge. The parent was told about a badge the
 * child was never told about, and the only thing that separated the two rows
 * was that the CHILD's own inbox had been busier that hour than the parent's —
 * an accident of which crossing happened first.
 *
 * `ONCE_EVER_TYPES` fixes THAT incident, by removing the volume penalty from a
 * fact that has no second chance. This file exists because the incident is an
 * instance of a CLASS, and the class outlives its instance:
 *
 *   - the two audiences are scored against two DIFFERENT inboxes, by design
 *     (`NotificationContextAssembler.readHistory` — and reading the parent's
 *     inbox for a child candidate was itself a measured defect);
 *   - so the two rows for one cause can and do get different scores;
 *   - so ANY per-audience rule — a cap, a cooldown, a preference, a future
 *     ranking change, a badly-chosen weight — can push one under a floor while
 *     the other clears it;
 *   - and the failure is SILENT. Both rows look individually reasonable. It
 *     took reading them side by side, grouped by cause, to see it at all.
 *
 * A product whose stated position is that a child is a participant and not a
 * subject cannot let «the parent knows, the child does not» be reachable by
 * arithmetic. So it is checked, by cause, over the rows the system actually
 * wrote — never by trusting the code that wrote them.
 *
 * ---------------------------------------------------------------------------
 * THE DIRECTION IS DELIBERATELY ONE-WAY.
 * ---------------------------------------------------------------------------
 *
 * CHILD lost while PARENT was told is a defect. The mirror — the child is told
 * and the parent is not — is NOT flagged here, and that asymmetry in the
 * invariant is the product's own: `DAILY_GOAL_COMPLETED` is classed `CHILD`
 * audience with the note that «your son finished his water goal» is the monitor
 * behaviour this product exists not to have. Many causes legitimately notify
 * only the child. NONE legitimately notifies only the parent about the child's
 * own achievement while the child is silenced by a cap.
 *
 * ---------------------------------------------------------------------------
 * DEFERRAL IS NOT LOSS, AND «ALREADY KNOWN» IS NOT LOSS EITHER.
 * ---------------------------------------------------------------------------
 *
 * `audienceOutcomeOf` below folds a decision row into three states, and the
 * distinction is the same one `notification-class.ts` draws between DEFER and
 * SUPPRESS:
 *
 *   TOLD  the audience has the fact now.
 *   HELD  the audience will have it — a quiet-hours deferral, released at
 *         07:00. A badge told the next morning is still told.
 *   LOST  the audience will never have it.
 *
 * A row refused because the audience ALREADY HAS the fact (`DUPLICATE`,
 * `ALREADY_NOTIFIED`, `ALREADY_DEFERRED`) is TOLD, not LOST: the unique index
 * refusing a redelivered cause is the system working, and counting it as a loss
 * would make this invariant fire on every retried outbox message.
 *
 * FRAMEWORK-FREE AND PURE, like everything else in `domain/engine`. It takes
 * rows and returns violations; it opens no database and reads no clock, so the
 * same function can be run over a test's own cohort, over an operator's export,
 * or in a sweep — and cannot disagree with itself between them.
 */

/** What one audience ended up knowing about one cause. */
export type AudienceOutcome = 'TOLD' | 'HELD' | 'LOST';

/**
 * One `notification_decisions` row, reduced to the columns this question needs.
 * Named after the columns rather than after a Prisma model so that a raw SQL
 * read, an ORM read and a synthetic fixture can all satisfy it.
 */
export interface AudienceDecisionRow {
  /** The PRODUCER'S key — the bare one, identical for both audiences of one
   * cause. `RewardsEngineService` notifies `BADGE_EARNED` and
   * `BADGE_EARNED_PARENT` under ONE `badgeKey`; the `:child` facet is appended
   * later, by the DELIVERY layer, and never reaches this column. That is what
   * makes grouping on it «the same occurrence» rather than «a similar one». */
  readonly sourceEventId: string;
  readonly targetAudience: 'PARENT' | 'CHILD';
  readonly eventType: string;
  /** `notification_decisions.decision` — the engine's verdict. */
  readonly decision: 'SEND' | 'DEFER' | 'SUPPRESS';
  /** `notification_decisions.reason`. */
  readonly reason: string | null;
  /** `notification_decisions.outcome` — what the delivery pipeline then did.
   * `null` when the verdict was terminal and delivery was never attempted. */
  readonly outcome: 'SEND' | 'DEFER' | 'SUPPRESS' | null;
  /** `notification_decisions.outcome_reason`. */
  readonly outcomeReason: string | null;
}

export interface AudienceAsymmetry {
  readonly sourceEventId: string;
  /** The child's row: the one that was lost. */
  readonly childEventType: string;
  readonly childDecision: string;
  readonly childReason: string | null;
  /** The parent's row for the same cause: the one that got through. */
  readonly parentEventType: string;
  readonly parentOutcome: AudienceOutcome;
  /** One line, ready to put in a failure message or a log, naming the cause and
   * both sides. An invariant whose report a human cannot act on has failed. */
  readonly detail: string;
}

/**
 * The reasons that mean «this audience already has this fact», so a refusal
 * carrying one of them is not a loss.
 *
 * A CLOSED LIST, and short on purpose. `DELIVERY_ERROR` is NOT here — a store
 * that was unreachable did not tell anybody anything — and neither is any cap
 * reason, which is the entire point.
 */
const ALREADY_KNOWN_REASONS: ReadonlySet<string> = new Set([
  'DUPLICATE',
  'ALREADY_NOTIFIED',
  'ALREADY_DEFERRED',
]);

/**
 * Fold one row into what its audience ended up knowing.
 *
 * THE OUTCOME OVERRIDES THE VERDICT WHERE IT EXISTS, because the verdict is
 * what the engine intended and the outcome is what the pipeline did — and the
 * measured incident had a row reading `decision=SEND, outcome=SUPPRESS/COOLDOWN`,
 * which an invariant reading only `decision` would have called a success.
 */
export function audienceOutcomeOf(row: AudienceDecisionRow): AudienceOutcome {
  if (row.decision === 'SUPPRESS') return 'LOST';
  if (row.outcome === null) {
    // Decided but never delivered — the process died between the ledger write
    // and the pipeline, or the verdict is a deferral this layer records without
    // a delivery attempt. DEFER is HELD; a SEND with no outcome is honestly
    // unknown, and «unknown» must not be reported as a loss the operator then
    // cannot find.
    return row.decision === 'DEFER' ? 'HELD' : 'TOLD';
  }
  if (row.outcome === 'DEFER') return 'HELD';
  if (row.outcome === 'SEND') return 'TOLD';
  return row.outcomeReason !== null && ALREADY_KNOWN_REASONS.has(row.outcomeReason) ? 'TOLD' : 'LOST';
}

/**
 * THE INVARIANT ITSELF. Returns every cause for which the child lost the news
 * and the parent did not.
 *
 * Rows for causes that reached only ONE audience are not violations and are not
 * examined: a cause with no parent row cannot have told the parent anything,
 * and a cause with no child row was never the child's to hear.
 */
export function findAudienceAsymmetries(
  rows: readonly AudienceDecisionRow[],
): readonly AudienceAsymmetry[] {
  const byCause = new Map<string, AudienceDecisionRow[]>();
  for (const row of rows) {
    const bucket = byCause.get(row.sourceEventId);
    if (bucket) bucket.push(row);
    else byCause.set(row.sourceEventId, [row]);
  }

  const violations: AudienceAsymmetry[] = [];
  for (const [sourceEventId, bucket] of byCause) {
    const childRows = bucket.filter((r) => r.targetAudience === 'CHILD');
    const parentRows = bucket.filter((r) => r.targetAudience === 'PARENT');
    if (childRows.length === 0 || parentRows.length === 0) continue;

    // The child has to have lost it on EVERY row it had for this cause. A cause
    // that produced two child candidates and delivered one of them told the
    // child; only a total loss is the defect.
    if (!childRows.every((r) => audienceOutcomeOf(r) === 'LOST')) continue;

    const parentGotIt = parentRows.find((r) => audienceOutcomeOf(r) !== 'LOST');
    if (!parentGotIt) continue;

    const lost = childRows[0];
    const parentOutcome = audienceOutcomeOf(parentGotIt);
    violations.push({
      sourceEventId,
      childEventType: lost.eventType,
      childDecision: lost.decision,
      childReason: lost.outcomeReason ?? lost.reason,
      parentEventType: parentGotIt.eventType,
      parentOutcome,
      detail:
        `cause ${sourceEventId}: the PARENT was ${parentOutcome} via ${parentGotIt.eventType}, ` +
        `while the CHILD's ${lost.eventType} was ${lost.decision}` +
        `${lost.outcomeReason ?? lost.reason ? ` (${lost.outcomeReason ?? lost.reason})` : ''} ` +
        'and will never be delivered',
    });
  }
  return violations;
}
