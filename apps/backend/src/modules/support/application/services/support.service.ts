import { Inject, Injectable } from '@nestjs/common';

import {
  SUPPORT_REQUEST_REPOSITORY,
  type ISupportRequestRepository,
  type ISupportRequestRecord,
} from '../../domain/support.types';
import { CreateSupportRequestDto } from '../dto/create-support-request.dto';
import { EntitlementsService } from '../../../billing/application/services/entitlements.service';

@Injectable()
export class SupportService {
  constructor(
    @Inject(SUPPORT_REQUEST_REPOSITORY) private readonly repository: ISupportRequestRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** HONEST NOTE: `familyId`/`userId` in the DTO are client-supplied,
   * NOT verified against a JWT here (this endpoint is deliberately
   * public/unauthenticated — see the DTO's own docstring for why).
   * They are metadata on an internal support record a human reads
   * later, never used to authorize any read/write elsewhere — a
   * mismatched value here has no security consequence beyond
   * slightly-wrong context on one support request.
   *
   * SAME CAVEAT APPLIES to `isPriority` below (CLOSES A REAL GAP —
   * 'priority_support' existed as a plan feature since Sprint 8 with
   * zero enforcement anywhere): the worst case of a spoofed familyId
   * here is a free-tier request incorrectly flagged priority in an
   * internal support queue — low-stakes, unlike every other
   * entitlement check in this codebase which gates real data access
   * and is therefore JWT-verified. Accepted deliberately, not an
   * oversight, given what's actually at risk. */
  async submit(dto: CreateSupportRequestDto): Promise<ISupportRequestRecord> {
    const isPriority = dto.familyId ? await this.entitlements.hasFeature(dto.familyId, 'priority_support') : false;

    return this.repository.create({
      familyId: dto.familyId ?? null,
      userId: dto.userId ?? null,
      email: dto.email,
      subject: dto.subject,
      message: dto.message,
      isPriority,
    });
  }

  /** CLOSES A CRITICAL GAP (proactive business audit) — the read
   * side this write-only module was missing entirely. */
  async listAll(): Promise<ISupportRequestRecord[]> {
    return this.repository.listAll(200);
  }
}
