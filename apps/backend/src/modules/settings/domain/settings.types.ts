export interface IFamilySettings {
  id: string;
  name: string;
  timezone: string;
  /**
   * F1. ISO-3166 alpha-2, or `null` for a household created before the column
   * existed (or one that never told us where it is).
   *
   * NULL IS A REAL, KEPT ANSWER and not a hole to be filled: `schema.prisma`
   * states beside the column that defaulting these families to 'EG' «would make
   * the growth dashboard report invented market data as measured fact». It is
   * echoed as `null` rather than omitted, so a client can tell "not set" from
   * "this API does not know about the field".
   */
  countryCode: string | null;
  subscriptionPlan: string;
}

export interface IUpdateFamilySettingsInput {
  name?: string;
  timezone?: string;
  /**
   * F1. Already normalised (`eg` -> `EG`) and already verified against the
   * ACTIVE rows of the `countries` catalogue by `SettingsService`; the
   * repository writes it as given.
   */
  countryCode?: string;
}

export const SETTINGS_REPOSITORY = Symbol('SETTINGS_REPOSITORY');

export interface ISettingsRepository {
  findByFamilyId(familyId: string): Promise<IFamilySettings | null>;
  update(familyId: string, input: IUpdateFamilySettingsInput): Promise<IFamilySettings>;
}
