import type { Child } from '@prisma/client';
import type { ICreateChildInput, IUpdateChildInput } from '../../domain/child.types';

export const CHILD_REPOSITORY = Symbol('CHILD_REPOSITORY');

export interface IChildRepository {
  create(familyId: string, input: ICreateChildInput): Promise<Child>;
  findManyByFamily(familyId: string): Promise<Child[]>;
  /** Returns null if the child doesn't exist, is soft-deleted, OR belongs
   * to a different family — all three cases are indistinguishable to the
   * caller (see ChildNotFoundException's docstring for why). */
  findOneScopedToFamily(childId: string, familyId: string): Promise<Child | null>;
  update(childId: string, input: IUpdateChildInput): Promise<Child>;
  softDelete(childId: string): Promise<void>;
}
