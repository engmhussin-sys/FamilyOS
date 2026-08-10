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
