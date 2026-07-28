export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface ILlmCompletionParams {
  systemPrompt: string;
  userMessage: string;
}

/**
 * A minimal, provider-agnostic port. If the project ever needs to switch
 * models/providers, or add a second one for cost-tiering, only the
 * infrastructure adapter changes — AiAssistantService never imports
 * @anthropic-ai/sdk directly.
 */
export interface ILlmClient {
  /** Returns the model's plain-text reply, or throws on any failure
   * (timeout, API error, empty response) — callers must not assume success. */
  complete(params: ILlmCompletionParams): Promise<string>;
}
