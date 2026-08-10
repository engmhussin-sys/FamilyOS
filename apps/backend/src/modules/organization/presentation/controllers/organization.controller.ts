import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { OrganizationService } from '../../application/services/organization.service';
import { CampaignRedemptionService } from '../../application/services/campaign-redemption.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { SetPolicyDto } from '../dto/set-policy.dto';
import { CreateCampaignDto } from '../dto/create-campaign.dto';
import { RedeemCampaignDto } from '../dto/redeem-campaign.dto';
import { UpdateBrandingDto } from '../dto/update-branding.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

/**
 * Sprint B1 — the first real endpoints for the Organization surface
 * (B2B2C: schools, companies, banks). Every route requires a
 * genuine, authenticated User (JwtAuthGuard) — organization
 * membership itself is what OrganizationService's RBAC checks gate,
 * not a separate guard layer.
 *
 * UPDATED (proactive security audit after Sprint B6): CLOSES A REAL
 * GAP — zero rate limiting existed on ANY endpoint here. Most
 * critical: campaigns/redeem accepts a bare code string with no
 * other verification, making it a real brute-force target (guessing
 * valid partner codes) without a tight limit. Every write endpoint
 * gets the same tightening already established elsewhere in this
 * codebase (ConsentController: 10/min, SupportController: 5/min).
 */
@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly campaignRedemptionService: CampaignRedemptionService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Body() dto: CreateOrganizationDto, @CurrentUser() user: IJwtPayload) {
    return this.organizationService.createOrganization(user.sub, dto.type, dto.name, dto.parentOrganizationId ?? null);
  }

  /** Sprint B3 — must be registered before ':organizationId' so Nest
   * doesn't try to treat the literal "mine" as an organizationId. */
  @Get('mine')
  listMine(@CurrentUser() user: IJwtPayload) {
    return this.organizationService.listMyOrganizations(user.sub);
  }

  @Get(':organizationId')
  getOne(@Param('organizationId') organizationId: string, @CurrentUser() user: IJwtPayload) {
    return this.organizationService.getOrganizationOrThrow(organizationId, user.sub);
  }

  @Get(':organizationId/members')
  listMembers(@Param('organizationId') organizationId: string, @CurrentUser() user: IJwtPayload) {
    return this.organizationService.listMembers(organizationId, user.sub);
  }

  @Post(':organizationId/invitations')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  inviteMember(
    @Param('organizationId') organizationId: string,
    @Body() dto: InviteMemberDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.organizationService.inviteMember(organizationId, user.sub, dto.email, dto.role);
  }

  /** CLOSES A CRITICAL GAP found in a final review: invitations could
   * be created with no way to accept them. Deliberately NOT scoped
   * under an organizationId — an invitation id alone identifies
   * everything needed; the person accepting isn't necessarily a
   * member of anything yet. */
  @Post('invitations/:invitationId/accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvitation(@Param('invitationId') invitationId: string, @CurrentUser() user: IJwtPayload) {
    return this.organizationService.acceptInvitation(invitationId, user.sub);
  }

  /** Sprint B2 — the Policy Engine surface. */
  @Post(':organizationId/policies')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  setPolicy(
    @Param('organizationId') organizationId: string,
    @Body() dto: SetPolicyDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.organizationService.setPolicy(organizationId, user.sub, dto.key, dto.value);
  }

  @Get(':organizationId/policies/:key/effective')
  getEffectivePolicy(
    @Param('organizationId') organizationId: string,
    @Param('key') key: string,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.organizationService.getEffectivePolicy(organizationId, user.sub, key);
  }

  /** Sprint B4 — Partner Campaigns. */
  @Post(':organizationId/campaigns')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createCampaign(
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateCampaignDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.organizationService.createCampaign(organizationId, user.sub, dto.code, dto.type, dto.config, dto.isActive ?? true);
  }

  /** CLOSES A REAL GAP found in a final usability review. */
  @Get(':organizationId/campaigns')
  listCampaigns(@Param('organizationId') organizationId: string, @CurrentUser() user: IJwtPayload) {
    return this.organizationService.listCampaigns(organizationId, user.sub);
  }

  /** Deliberately NOT scoped under an organizationId in the URL — a
   * code is redeemed by whoever has it, for THEIR OWN family, not
   * "as a member of" the issuing organization (a bank distributes a
   * code to non-member customers; they never join the bank's
   * Organization to redeem it).
   *
   * TIGHTEST limit in this entire controller (5/min) — this is the
   * one real brute-force target: a bare code string with no other
   * identity check, guessable by trying many values quickly. */
  @Post('campaigns/redeem')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  redeemCampaign(@Body() dto: RedeemCampaignDto, @CurrentUser() user: IJwtPayload) {
    if (!user.familyId) {
      throw new ForbiddenException('You must belong to a family to redeem a campaign code.');
    }
    return this.campaignRedemptionService.redeem(dto.code, user.familyId);
  }

  /** Sprint B5 — White-Label. Write requires membership + WRITE
   * permission (checked inside the service). */
  @Post(':organizationId/branding')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  updateBranding(
    @Param('organizationId') organizationId: string,
    @Body() dto: UpdateBrandingDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.organizationService.updateBranding(organizationId, user.sub, dto);
  }
}
