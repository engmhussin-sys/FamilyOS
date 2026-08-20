import type {
  ICreateChildInput,
  IUpdateChildInput,
  IChildView,
  IChildWithPinCredential,
} from '../../domain/child.types';

export const CHILD_REPOSITORY = Symbol('CHILD_REPOSITORY');

/**
 * Every method here returns `IChildView` — the whitelist in
 * `child.types.ts` — and NOT the raw Prisma `Child`. The PIN hash is not
 * merely omitted from the response, it is never selected, so no caller of
 * this port can leak it by accident. The single exception is named
 * `...WithPinCredential` so it cannot be reached without saying so.
 */
export interface IChildRepository {
  create(familyId: string, input: ICreateChildInput): Promise<IChildView>;
  findManyByFamily(familyId: string): Promise<IChildView[]>;
  /** Returns null if the child doesn't exist, is soft-deleted, OR belongs
   * to a different family — all three cases are indistinguishable to the
   * caller (see ChildNotFoundException's docstring for why). */
  findOneScopedToFamily(childId: string, familyId: string): Promise<IChildView | null>;
  /** THE ONLY PATH THAT READS THE PIN HASH. Same family scoping as
   * `findOneScopedToFamily`; exists for child-app PIN verification, which
   * runs server-side and never echoes the row back to a client. */
  findOneWithPinCredentialScopedToFamily(
    childId: string,
    familyId: string,
  ): Promise<IChildWithPinCredential | null>;
  update(childId: string, input: IUpdateChildInput): Promise<IChildView>;
  softDelete(childId: string): Promise<void>;
}
