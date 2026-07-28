import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown whenever the underlying LLM call fails for any reason (timeout,
 * API error, rate limit, malformed/empty response). Deliberately generic
 * to the caller — the specific cause is logged server-side by
 * AiAssistantService, not exposed in the API response, since raw provider
 * error details (rate limit specifics, auth errors) aren't useful or safe
 * to hand back to a parent using the feature.
 */
export class AiAssistantUnavailableException extends ServiceUnavailableException {
  constructor() {
    super('The parenting assistant is temporarily unavailable. Please try again shortly.');
  }
}
