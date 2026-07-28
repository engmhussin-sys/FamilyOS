import { Inject, Injectable } from '@nestjs/common';
import type { Child } from '@prisma/client';

import type { ICreateChildInput, IUpdateChildInput } from '../../domain/child.types';
import { ChildNotFoundException } from '../../domain/child.errors';
import {
  CHILD_REPOSITORY,
  type IChildRepository,
} from '../ports/child.repository.port';

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
  ) {}

  createChild(familyId: string, input: ICreateChildInput): Promise<Child> {
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
