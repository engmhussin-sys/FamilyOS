export interface IAskAssistantInput {
  childId: string;
  /** The parent's free-text question, e.g. "My son plays 5 hours of games a day." */
  question: string;
}

/** The real, structured context pulled from our own database and injected
 * into the LLM prompt — this is what keeps the advice grounded in this
 * specific child rather than generic parenting content. */
export interface IChildContext {
  firstName: string;
  ageYears: number;
  dailyScreenLimitMinutes: number | null;
  focusModeEnabled: boolean;
}

export interface IAssistantAnswer {
  answer: string;
  generatedAt: Date;
}
