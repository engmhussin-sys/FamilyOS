export interface IFeatureFlagRecord {
  key: string;
  description: string;
  isEnabledGlobally: boolean;
  enabledFamilyIds: string[];
}

export const FEATURE_FLAG_REPOSITORY = Symbol('FEATURE_FLAG_REPOSITORY');

export interface IFeatureFlagRepository {
  findByKey(key: string): Promise<IFeatureFlagRecord | null>;
  listAll(): Promise<IFeatureFlagRecord[]>;
  upsert(record: IFeatureFlagRecord): Promise<void>;
}
