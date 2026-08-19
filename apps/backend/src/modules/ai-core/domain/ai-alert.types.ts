/**
 * ============================================================================
 * THE AI SAFETY ALERT — THE AI LAYER'S OUTPUT CONTRACT, AS A PORT.
 * ============================================================================
 *
 * WHAT THIS CLOSES. `prisma/schema.prisma` says it above the model itself:
 * «A single actionable alert surfaced to parents. This is the AI layer's
 * output contract — parents see alerts, never raw monitored content.» The
 * table had READERS AND NO WRITER. `GrowthAlertsService.aiSafetyIncident`
 * scanned it for un-reviewed CRITICAL rows under a comment reading «one is one
 * too many» and scanned an empty table on every tick, so the one alerting path
 * this product cannot afford to have dormant could never fire.
 *
 * THE ROW IS A CLASSIFICATION AND A NEXT STEP. IT IS NOT A TRANSCRIPT.
 * Every field below is enumerated or human-written; there is deliberately NO
 * field on this input for the text that caused the detection, no field for a
 * fragment of it, no field for a hash of it, and no free-form `metadata` blob —
 * because a JSON blob is where a raw quote ends up when somebody adds
 * «context» to an alert six months from now. That is the same argument
 * `DistressEscalationService` makes for passing no `data` payload to the
 * notification writer, and it is made here again because this is a SECOND
 * table with the same temptation.
 *
 * WHY THE ENUMS ARE RESTATED AS UNIONS RATHER THAN IMPORTED FROM `@prisma/client`.
 * This file is the ai-core DOMAIN: framework-free and ORM-free, like
 * `distress.ts` and `prompt-safety.ts` beside it. The unions below are assigned
 * to the real Prisma enums in `infrastructure/prisma-ai-alert.repository.ts`,
 * so if `AlertCategory` or `AlertSeverity` ever changes in the schema, `tsc`
 * fails AT THE MAPPING rather than at runtime on an insert.
 */

/** `AlertCategory` in `schema.prisma`. */
export type AiAlertCategory = 'DIGITAL_SAFETY' | 'BEHAVIOR' | 'HEALTH' | 'EDUCATION' | 'LOCATION';

/** `AlertSeverity` in `schema.prisma`. */
export type AiAlertSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** `AlertStatus` in `schema.prisma`. */
export type AiAlertStatus = 'NEW' | 'REVIEWED' | 'DISMISSED' | 'ESCALATED';

export interface IRecordAiAlertInput {
  readonly childId: string;
  readonly category: AiAlertCategory;
  readonly severity: AiAlertSeverity;
  /** Human-written, Arabic-first, and identical for every classification the
   * producer can make — see `DISTRESS_ALERT_COPY`. */
  readonly title: string;
  readonly description: string;
  /** Which subsystem raised it, so an operator reading the row does not have to
   * grep for the producer. The schema's own example is «keyboard-behavior-ai». */
  readonly sourceModule: string;
  /**
   * WHAT MAKES THIS ALERT THE SAME ALERT. Required, with no default anywhere in
   * this layer: a default is exactly how a producer silently opts out of a
   * unique constraint. Held by `ai_alerts (family_id, source_event_id)` UNIQUE
   * (migration 0027), so a replayed detection is refused by PostgreSQL.
   */
  readonly sourceEventId: string;
}

/** What a PARENT is given. `sourceEventId` is absent on purpose — it is the
 * server's dedupe key, not a fact about the child. */
export interface IAiAlertView {
  readonly id: string;
  readonly childId: string;
  readonly childFirstName: string;
  readonly category: AiAlertCategory;
  readonly severity: AiAlertSeverity;
  readonly status: AiAlertStatus;
  readonly title: string;
  readonly description: string;
  readonly sourceModule: string;
  readonly createdAt: Date;
}

export const AI_ALERT_REPOSITORY = Symbol('AI_ALERT_REPOSITORY');

export interface IAiAlertRepository {
  /**
   * Writes the alert, or does nothing because it already exists.
   *
   * Returns whether a row was WRITTEN. `false` means the unique index refused
   * the insert — a replayed detection did its job the first time — which is a
   * SUCCESS, not a failure. `void` would make an idempotent no-op
   * indistinguishable from a real alert, and the caller reports the difference.
   */
  record(input: IRecordAiAlertInput): Promise<boolean>;

  /** The parent's read side, newest first. Family-scoped by the caller's token,
   * never by anything the request body carries. */
  listForFamily(familyId: string, limit: number): Promise<IAiAlertView[]>;
}
