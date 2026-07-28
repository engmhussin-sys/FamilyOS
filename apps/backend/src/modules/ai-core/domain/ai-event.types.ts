/**
 * Decision-068's "Event-based AI input model." Only `PARENT_QUESTION` is
 * actually consumed by any code today (the Parenting Assistant).
 * `SCREEN_TIME_EXCEEDED` and the extensible `context` field exist as a
 * structural placeholder for Sprint AI-2's Behavioral Intelligence
 * Engine — declared now so that engine has a schema to implement
 * against later, not built speculatively here (this project's
 * established YAGNI discipline — see IRiskDetector's identical framing
 * in the Child Agent's plugin contracts).
 */
export type AIEventType = 'PARENT_QUESTION' | 'SCREEN_TIME_EXCEEDED';

export interface IAIEvent {
  eventType: AIEventType;
  childId: string;
  familyId: string;
  occurredAt: Date;
  /** Event-specific payload — e.g. `{ app: "YouTube", durationMinutes: 120 }`
   * for SCREEN_TIME_EXCEEDED. Opaque at this layer for the same reason
   * ScreenTimePolicy.weekdaySchedule is opaque JSON (screen-time-module.md
   * §3) — the exact shape per event type is a decision for whichever
   * engine consumes it, not this shared schema. */
  context?: Record<string, unknown>;
}
