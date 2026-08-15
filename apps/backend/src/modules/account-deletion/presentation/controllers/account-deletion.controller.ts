import { Body, Controller, Delete, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AccountDeletionService } from '../../application/services/account-deletion.service';
import { DeleteAccountDto } from '../../application/dto/delete-account.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { OwnerOnly } from '../../../../common/authz/roles.decorator';

@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountDeletionController {
  constructor(private readonly accountDeletionService: AccountDeletionService) {}

  /** Tightly rate-limited given how destructive-feeling this action
   * is — 3/min is generous for a genuine retry after a typo'd
   * password, tight enough to slow any automated abuse of a stolen
   * session token. */
  @Delete()
  // PHASE C. This deletes the FAMILY, not merely a login: it cancels the
  // subscription and soft-deletes every child. A4's custody-dispute scenario is
  // exactly this route reached by the wrong parent. OWNER only — and the
  // service re-reads `family_members` before acting, so a 15-minute-stale
  // OWNER claim from a parent demoted moments ago still cannot execute it.
  @OwnerOnly()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(@Body() dto: DeleteAccountDto, @CurrentUser() user: IJwtPayload): Promise<void> {
    await this.accountDeletionService.deleteAccount(user.sub, user.familyId!, dto.currentPassword);
  }
}
