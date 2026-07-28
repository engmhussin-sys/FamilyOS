import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown whenever the underlying AI provider call fails for any reason.
 * Renamed/relocated from the old AiAssistantUnavailableException
 * (ai-assistant module) — now a shared, provider-agnostic error every AI
 * feature built on AiCoreOrchestratorService raises identically, not a
 * per-feature exception each engine would otherwise reinvent.
 */
export class AiCoreUnavailableException extends ServiceUnavailableException {
  constructor() {
    super('The AI service is temporarily unavailable. Please try again shortly.');
  }
}
