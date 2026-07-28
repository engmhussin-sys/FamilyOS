import { Injectable } from '@nestjs/common';

import { AiCoreOrchestratorService } from '../../../ai-core/application/services/ai-core-orchestrator.service';
import type { IAssistantAnswer } from '../../../ai-core/application/services/ai-core-orchestrator.service';

/**
 * Per Decision-068: this service no longer builds context or calls an AI
 * provider itself (that logic moved to AiContextManagerService /
 * AiCoreOrchestratorService in the shared ai-core module — see
 * docs/architecture/ai-core-engine-boundary.md). AiAssistantService is
 * now a thin, feature-scoped entry point — it exists so the controller/
 * route/DTO surface (POST /ai-assistant/ask) stays stable while the
 * underlying implementation is fully shared infrastructure. Deleting
 * this class and calling AiCoreOrchestratorService directly from the
 * controller was considered and rejected: keeping one thin service per
 * feature preserves a place for feature-specific concerns (e.g. future
 * per-feature rate limiting logic, analytics) without those concerns
 * leaking into the shared orchestrator.
 */
@Injectable()
export class AiAssistantService {
  constructor(private readonly aiCoreOrchestrator: AiCoreOrchestratorService) {}

  ask(childId: string, familyId: string, question: string): Promise<IAssistantAnswer> {
    return this.aiCoreOrchestrator.askParentingQuestion(childId, familyId, question);
  }
}
