export interface ISetScreenTimePolicyInput {
  dailyLimitMinutes?: number;
  /** "HH:mm", local to the child's device — e.g. "21:00" */
  bedtimeStart?: string;
  bedtimeEnd?: string;
  /** Per-weekday overrides, shape owned by the frontend for now — e.g.
   * { "friday": { "dailyLimitMinutes": 180 } }. Kept as an opaque JSON
   * object at this layer; validated only for "is it an object" at the DTO
   * level (see set-screen-time-policy.dto.ts) rather than a rigid schema,
   * since the exact per-weekday shape is still likely to evolve. */
  weekdaySchedule?: Record<string, unknown>;
  focusModeEnabled?: boolean;
}
