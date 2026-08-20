/** Architecture 1.0 §5 — the exact category vocabulary approved for the
 * unified timeline. A plain union type (not importing the Prisma enum
 * directly into the domain layer) so the domain stays decoupled from
 * the ORM, matching this project's own Repository Pattern discipline
 * elsewhere (e.g. ai-core's domain/ layer never imports @prisma/client).
 */
export type TimelineCategory = 'HEALTH' | 'LEARNING' | 'FAITH' | 'REWARDS' | 'SAFETY' | 'HABITS' | 'FAMILY';

export interface ILifeTimelineEvent {
  id: string;
  childId: string;
  sourceEngine: string;
  category: TimelineCategory;
  eventType: string;
  title: string;
  occurredAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface IRecordTimelineEventInput {
  childId: string;
  sourceEngine: string;
  category: TimelineCategory;
  eventType: string;
  title: string;
  metadata?: Record<string, unknown>;
  /**
   * PHASE C (`PC-B-006`) — OPT-IN EXACTLY-ONCE.
   *
   * When present, this entry is unique per `(childId, sourceKey)`, enforced by
   * `life_timeline_events_reward_source_key_uq` (migration 0010) and not by any
   * check in code. A second `record()` carrying the same key is a NO-OP, not an
   * error — «this curated moment is already on the timeline» is a success, the
   * same way `OutboxWriter`'s caught P2002 means «this occurrence is already
   * recorded».
   *
   * OPTIONAL, and that is what keeps this additive. Every other engine's
   * timeline write (`first_habit_completion`, `hydration_target_reached`,
   * `badge_awarded`, `level_up`, ...) passes nothing, writes no key, falls
   * outside the PARTIAL index, and behaves exactly as it did before Phase C.
   * Only the reward-granted entry — the one the ONE TIMELINE ENTRY invariant is
   * actually about — opts in.
   *
   * Stored INSIDE `metadata` rather than in a column of its own because
   * `prisma generate` is unreachable in this environment (403), so a new column
   * could not reach the generated client. The database guarantee is identical;
   * only the ergonomics are worse. Migration 0010's header carries the full note.
   */
  sourceKey?: string;
}

/** The one seam every engine writes through — Architecture 1.0 §1:
 * "No engine writes directly into another engine['s table]." Every
 * engine depends on this interface, never on `LifeTimelineService`'s
 * concrete class, matching the Provider Pattern used for AI_PROVIDER
 * elsewhere in this codebase. */
export const LIFE_TIMELINE_WRITER = Symbol('LIFE_TIMELINE_WRITER');

export interface ILifeTimelineWriter {
  record(input: IRecordTimelineEventInput): Promise<void>;
}
