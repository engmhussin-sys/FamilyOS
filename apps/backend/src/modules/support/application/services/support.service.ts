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

  /**
   * F2: the identity is now SERVER-DERIVED or absent. `actor` is built by the
   * controller from `request.user`, which only exists when
   * OptionalJwtAuthGuard verified a real token signature. An anonymous
   * submission stores `familyId: null` — honestly unattributed — and is never
   * priority, because there is no verified plan to check.
   *
   * The previous version read `dto.familyId`, i.e. trusted the request body,
   * which meant anyone could type a UUID and be treated as that family for the
   * `priority_support` entitlement lookup.
   */
  async submit(
    dto: CreateSupportRequestDto,
    actor?: { familyId?: string; userId?: string },
  ): Promise<ISupportRequestRecord> {
    const isPriority = actor?.familyId
      ? await this.entitlements.hasFeature(actor.familyId, 'priority_support')
      : false;

    return this.repository.create({
      familyId: actor?.familyId ?? null,
      userId: actor?.userId ?? null,
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
