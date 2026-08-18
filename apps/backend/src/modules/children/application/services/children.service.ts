import { Inject, Injectable, ForbiddenException } from '@nestjs/common';

import type {
  ICreateChildInput,
  IUpdateChildInput,
  IChildView,
  IChildWithPinCredential,
} from '../../domain/child.types';
import { ChildNotFoundException } from '../../domain/child.errors';
import {
  CHILD_REPOSITORY,
  type IChildRepository,
} from '../ports/child.repository.port';
import { GrowthEventEmitter } from '../../../analytics/application/growth-event-emitter.service';
import { EntitlementsService } from '../../../billing/application/services/entitlements.service';

/**
 * `getChildOrThrow` is this module's most important export — it is the
 * ONE place that answers "does this child belong to this family?" for the
 * whole backend. Every other module that accepts a childId from a request
 * (Screen Time policies, Location, and — as of this step — Auth's device
 * pairing flow) is expected to call through here rather than querying
 * Prisma directly, so that family-scoping is enforced identically
 * everywhere instead of being re-implemented (and potentially
 * re-forgotten) per module.
 *
 * WHAT IT HANDS BACK IS `IChildView`, NEVER THE PRISMA `Child`. The row
 * carries `pinCodeHash` — the child app's login PIN, hashed, and a
 * four-digit PIN's hash is a credential anyone can invert offline. It used
 * to be returned verbatim by `GET /children` and `GET /children/:childId`.
 * The whitelist that stops that lives in `child.types.ts` and is applied
 * in the repository's `select`, so the hash is not read out of PostgreSQL
 * at all on these paths and a new column is unexposed by default. The one
 * caller that legitimately needs the credential —  child-app PIN
 * verification — uses `getChildWithPinCredentialOrThrow` below and says so
 * in its own name.
 */
@Injectable()
export class ChildrenService {
  constructor(
    @Inject(CHILD_REPOSITORY) private readonly childRepository: IChildRepository,
    private readonly entitlements: EntitlementsService,
    /** PHASE D (GROWTH). From `GrowthCaptureModule` — it imports nothing, so
     * no module cycle is constructible through it. */
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /** CLOSES A REAL GAP (proactive business/code audit): 'multiple_children'
   * has existed as a plan feature since Sprint 8 with zero enforcement
   * anywhere. The first child is always free on every tier — only the
   * SECOND-and-beyond child requires the entitlement. Fails closed,
   * matching every other authorization check in this codebase. */
  async createChild(familyId: string, input: ICreateChildInput): Promise<IChildView> {
    const existingChildren = await this.childRepository.findManyByFamily(familyId);
    if (existingChildren.length >= 1) {
      const entitled = await this.entitlements.hasFeature(familyId, 'multiple_children');
      if (!entitled) {
        throw new ForbiddenException('Adding more than one child requires a plan with the multiple_children feature.');
      }
    }
    const child = await this.childRepository.create(familyId, input);

    /**
     * PHASE D (GROWTH) — the CHILD_ADDED funnel step.
     *
     * AFTER the write, and the emitter never throws (see its class docstring),
     * so a failure here cannot cost a parent the child they just added.
     * The payload carries a COUNT, never the child's id, name or birth date —
     * `childId` is not in `ALLOWED_PAYLOAD_KEYS` at all, so passing it would be
     * dropped and logged rather than stored. CONTEXT §3 principle 8.
     */
    await this.growthEvents.emit({
      name: 'CHILD_ADDED',
      familyId,
      sessionId: `children:${familyId}`,
      payload: { childCount: existingChildren.length + 1 },
    });

    return child;
  }

  listChildren(familyId: string): Promise<IChildView[]> {
    return this.childRepository.findManyByFamily(familyId);
  }

  async getChildOrThrow(childId: string, familyId: string): Promise<IChildView> {
    const child = await this.childRepository.findOneScopedToFamily(childId, familyId);
    if (!child) {
      throw new ChildNotFoundException(childId);
    }
    return child;
  }

  /**
   * THE ONLY WAY TO OBTAIN A CHILD'S PIN HASH, and it is deliberately a
   * mouthful. Same family scoping and same `ChildNotFoundException` as
   * `getChildOrThrow`; the difference is that the returned object carries
   * `pinCodeHash`, so it must be consumed server-side (comparing a
   * submitted PIN against the hash) and MUST NOT be returned from a
   * controller. No controller calls it — the children controller returns
   * `getChildOrThrow`'s view, and a code review that sees this name at a
   * presentation-layer call site is looking at a bug.
   */
  async getChildWithPinCredentialOrThrow(
    childId: string,
    familyId: string,
  ): Promise<IChildWithPinCredential> {
    const child = await this.childRepository.findOneWithPinCredentialScopedToFamily(
      childId,
      familyId,
    );
    if (!child) {
      throw new ChildNotFoundException(childId);
    }
    return child;
  }

  /** Convenience for callers (like PairingService) that only need to
   * assert ownership, not the full record — same guarantee, clearer intent
   * at the call site. */
  async assertChildBelongsToFamily(childId: string, familyId: string): Promise<void> {
    await this.getChildOrThrow(childId, familyId);
  }

  async updateChild(childId: string, familyId: string, input: IUpdateChildInput): Promise<IChildView> {
    await this.getChildOrThrow(childId, familyId); // enforces ownership before mutating
    return this.childRepository.update(childId, input);
  }

  async deleteChild(childId: string, familyId: string): Promise<void> {
    await this.getChildOrThrow(childId, familyId);
    await this.childRepository.softDelete(childId);
  }
}
