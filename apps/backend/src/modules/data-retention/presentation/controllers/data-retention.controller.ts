import { Controller, Get, UseGuards } from '@nestjs/common';

import { DataRetentionPolicyService } from '../../domain/data-retention-policy.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('system/retention-policy')
@UseGuards(JwtAuthGuard)
export class DataRetentionController {
  constructor(private readonly policyService: DataRetentionPolicyService) {}

  @Get()
  @ParentSurface()
  getPolicies() {
    return this.policyService.getPolicies();
  }
}
