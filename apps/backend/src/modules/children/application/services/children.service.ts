import { Inject, Injectable, ForbiddenException } from '@nestjs/common';
import type { Child } from '@prisma/client';

import type { ICreateChildInput, IUpdateChildInput } from '../../domain/child.types';
import { ChildNotFoundException } from '../../domain/child.errors';
import {
  CHILD_REPOSITORY,
  type IChildRepository,
} from '../ports/child.repository.port';
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
 */
@Injectable()
export class ChildrenService {
  constructor(
    @Inject(CHILD_REPOSITORY) private readonly childRepository: IChildRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** CLOSES A REAL GAP (proactive business/code audit): 'multiple_children'
   * has existed as a plan feature since Sprint 8 with zero enforcement
   * anywhere. The first child is always free on every tier — only the
   * SECOND-and-beyond child requires the entitlement. Fails closed,
   * matching every other authorization check in this codebase. */
  async createChild(familyId: string, input: ICreateChildInput): Promise<Child> {
    const existingChildren = await this.childRepository.findManyByFamily(familyId);
    if (existingChildren.length >= 1) {
      const entitled = await this.entitlements.hasFeature(familyId, 'multiple_children');
      if (!entitled) {
        throw new ForbiddenException('Adding more than one child requires a plan with the multiple_children feature.');
      }
    }
    return this.childRepository.create(familyId, input);
  }

  listChildren(familyId: string): Promise<Child[]> {
    return this.childRepository.findManyByFamily(familyId);
  }

  async getChildOrThrow(childId: string, familyId: string): Promise<Child> {
    const child = await this.childRepository.findOneScopedToFamily(childId, familyId);
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

  async updateChild(childId: string, familyId: string, input: IUpdateChildInput): Promise<Child> {
    await this.getChildOrThrow(childId, familyId); // enforces ownership before mutating
    return this.childRepository.update(childId, input);
  }

  async deleteChild(childId: string, familyId: string): Promise<void> {
    await this.getChildOrThrow(childId, familyId);
    await this.childRepository.softDelete(childId);
  }
}
