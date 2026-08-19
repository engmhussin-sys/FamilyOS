import type {
  IFeatureFlagEvaluation,
  IFeatureFlagKey,
  IFeatureFlagSummary,
} from './feature-flag.types';

/**
 * The WRITE shape. `description` lives here and on no read path: an operator
 * supplies it when a flag is created or updated, and no client-facing
 * projection selects it back out.
 */
export interface IFeatureFlagRecord {
  key: string;
  description: string;
  isEnabledGlobally: boolean;
  enabledFamilyIds: string[];
}

export const FEATURE_FLAG_REPOSITORY = Symbol('FEATURE_FLAG_REPOSITORY');

/**
 * Every read below names its projection in its RETURN TYPE, so which columns a
 * caller can reach is decided here rather than by whichever query an
 * implementation happens to write. See `feature-flag.types.ts` for what each
 * projection contains and the argument for it.
 */
export interface IFeatureFlagRepository {
  /** SERVER-SIDE evaluation only — the one read that sees the per-family
   * allow-list. Feeds a boolean and a write; never returned by a controller. */
  findByKey(key: string): Promise<IFeatureFlagEvaluation | null>;
  /** Every flag, WITHOUT the allow-list. */
  listAll(): Promise<IFeatureFlagSummary[]>;
  /** The keys THIS family is individually allow-listed for, answered by a
   * `where` clause so no other family's UUID is ever read out of Postgres. */
  listKeysEnabledForFamily(familyId: string): Promise<IFeatureFlagKey[]>;
  upsert(record: IFeatureFlagRecord): Promise<void>;
}
