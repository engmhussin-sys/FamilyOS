export interface IFamilySettings {
  id: string;
  name: string;
  timezone: string;
  subscriptionPlan: string;
}

export interface IUpdateFamilySettingsInput {
  name?: string;
  timezone?: string;
}

export const SETTINGS_REPOSITORY = Symbol('SETTINGS_REPOSITORY');

export interface ISettingsRepository {
  findByFamilyId(familyId: string): Promise<IFamilySettings | null>;
  update(familyId: string, input: IUpdateFamilySettingsInput): Promise<IFamilySettings>;
}
