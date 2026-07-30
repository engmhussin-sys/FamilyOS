import { Controller, Get, UseGuards } from '@nestjs/common';

import { DataRetentionPolicyService } from '../../domain/data-retention-policy.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';

@Controller('system/retention-policy')
@UseGuards(JwtAuthGuard)
export class DataRetentionController {
  constructor(private readonly policyService: DataRetentionPolicyService) {}

  @Get()
  getPolicies() {
    return this.policyService.getPolicies();
  }
}
