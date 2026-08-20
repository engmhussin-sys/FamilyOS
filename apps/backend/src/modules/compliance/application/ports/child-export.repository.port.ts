import type { IChildDataExportRecords } from '../../domain/compliance.types';

export const CHILD_EXPORT_REPOSITORY = Symbol('CHILD_EXPORT_REPOSITORY');

/**
 * The one read this module owns that no other service already exposes.
 *
 * `DataExportService`'s docstring explains why it composes ChildrenService /
 * ScreenTimeService / ConsentService rather than querying Prisma, and that
 * reasoning still holds for those three: each one already owns an
 * ownership check and a shaped read that would otherwise be duplicated here.
 *
 * It does NOT hold for the categories added by this port. There is no
 * "list every reward ledger entry for a subject-access request" method
 * anywhere in `src/`, and there should not be one: the read this needs is
 * bounded, aggregate-heavy and shaped by a compliance concern, not by any
 * feature screen. Inventing it inside `life-intelligence` would put a
 * compliance-shaped query in a module that has no compliance reason to change,
 * and would spread this export's field selection across six modules where no
 * single reviewer could see it whole. It lives behind one port instead, with
 * every `select` in one file that a privacy review can read start to finish.
 */
export interface IChildExportRepository {
  /**
   * Every additional category of a child's data, already bounded.
   *
   * Family scoping is the Prisma Client Extension's job (the same one every
   * other repository in this codebase relies on); `childId` narrows within
   * the tenant, and the caller has already proved the child belongs to it.
   */
  loadRecords(childId: string): Promise<IChildDataExportRecords>;
}
