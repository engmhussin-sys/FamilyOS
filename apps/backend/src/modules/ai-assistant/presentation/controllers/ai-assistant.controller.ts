import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AiAssistantService } from '../../application/services/ai-assistant.service';
import { AskAssistantDto } from '../dto/ask-assistant.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('ai-assistant')
@UseGuards(JwtAuthGuard)
export class AiAssistantController {
  constructor(private readonly aiAssistantService: AiAssistantService) {}

  @Post('ask')
  @ParentSurface()
  // Each call is a real, billed LLM request — throttled far tighter than
  // typical CRUD endpoints to bound cost from a single account.
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  ask(@Body() dto: AskAssistantDto, @CurrentUser() user: IJwtPayload) {
    return this.aiAssistantService.ask(dto.childId, user.familyId!, dto.question);
  }
}
