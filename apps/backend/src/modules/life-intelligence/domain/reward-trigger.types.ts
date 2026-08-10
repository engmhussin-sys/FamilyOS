import { IRewardTriggerEvent } from './rewards.types';

/** The one seam every engine triggers rewards through — Architecture
 * 1.0 \u00a71: "No engine writes directly into another engine['s table]."
 * Mirrors LIFE_TIMELINE_WRITER's exact pattern and reasoning: engines
 * depend on this small interface, never on RewardsEngineService's
 * concrete class. */
export const REWARD_TRIGGER_WRITER = Symbol('REWARD_TRIGGER_WRITER');

export interface IRewardTriggerWriter {
  /** Fire-and-forget from the caller's perspective — returns the
   * number of grants made, but callers are not required to act on it
   * (matches how LIFE_TIMELINE_WRITER.record() is used — a side
   * effect, not a value the caller's own logic branches on). */
  trigger(childId: string, familyId: string, event: IRewardTriggerEvent): Promise<number>;
}
