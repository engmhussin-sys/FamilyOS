/**
 * Decision-068's Knowledge Layer, MVP scope. Deliberately limited to
 * fields real data already exists for (Children/ScreenTime modules).
 * Sleep pattern, study schedule, and behavioral history — all present
 * in the reviewer's example JSON — are NOT included here because no
 * schema/module produces that data yet (Health & Education modules are
 * Phase 2 items not yet built). Adding placeholder fields with no real
 * data behind them would be worse than omitting them — see
 * ai-assistant-module.md's original "ground the prompt in real data,
 * not invented context" principle, now generalized to this shared layer.
 */
export interface IChildAIContext {
  childId: string;
  firstName: string;
  ageYears: number;
  screenTime: {
    dailyLimitMinutes: number | null;
    focusModeEnabled: boolean;
  };
}
