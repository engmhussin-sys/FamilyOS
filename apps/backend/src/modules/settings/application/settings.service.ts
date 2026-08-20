import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { FamilyDateService } from '../../../common/time/family-date.service';
import { canonicalTimeZone } from '../../../common/time/family-date';
import { CountryCatalogueService } from './country-catalogue.service';
import {
  SETTINGS_REPOSITORY,
  type ISettingsRepository,
  type IUpdateFamilySettingsInput,
} from '../domain/settings.types';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(SETTINGS_REPOSITORY) private readonly repository: ISettingsRepository,
    private readonly familyDate: FamilyDateService,
    /** F1. The catalogue check and the country/timezone rule — see its docstring. */
    private readonly countries: CountryCatalogueService,
  ) {}

  async getSettings(familyId: string) {
    const settings = await this.repository.findByFamilyId(familyId);
    if (!settings) {
      throw new NotFoundException('Family not found.');
    }
    return settings;
  }

  /**
   * B2 (PA-B-001). Two things happen here that did not before, and both are
   * load-bearing now that `Family.timezone` actually drives calculations:
   *
   *   1. CANONICALISATION. `"egypt"` is a valid tzdata link, and ICU resolves
   *      it to `"Africa/Cairo"`. Storing the alias would work — until a future
   *      reader compared the stored string to a canonical one. What is written
   *      is what tzdata will look up.
   *   2. CACHE INVALIDATION. `FamilyDateService` caches the zone for five
   *      minutes; without this call a parent who corrects their timezone would
   *      keep getting the old calendar for those five minutes, which on a day
   *      boundary is exactly when they would have noticed and gone looking.
   *
   * F1 ADDS A THIRD, for `countryCode`:
   *
   *   3. VOCABULARY AND COHERENCE. The code is checked against the ACTIVE rows
   *      of the `countries` catalogue BEFORE the write, so an unsupported market
   *      is a typed 400 with an Arabic sentence rather than a foreign-key
   *      violation from migration 0022 surfacing as a 500 with a constraint name
   *      in it. Then the country and the timezone are reconciled, because
   *      `Family.timezone` is what every business date is derived from and a row
   *      that says «Egypt» and «UTC» silently moves a household's day boundary.
   *      The rule itself, and why it is this rule, is documented on
   *      `CountryCatalogueService.reconcileTimeZone`.
   */
  async updateSettings(familyId: string, input: IUpdateFamilySettingsInput) {
    const countryCode =
      input.countryCode !== undefined
        ? await this.countries.resolveSupported(input.countryCode)
        : undefined;

    /**
     * WHICH COUNTRY THE TIMEZONE IS RECONCILED AGAINST.
     *
     * The one being SET if this request sets one; otherwise the one already
     * STORED. The second half matters: a household that is already `SA` and now
     * PATCHes `timezone: "Africa/Cairo"` alone is producing exactly the
     * incoherent row this rule exists to prevent, and refusing it only when both
     * fields happen to arrive in the same request would make the guarantee
     * depend on how a client chose to batch its writes.
     *
     * `enforce: true` at both call sites here: on this endpoint BOTH values are
     * client-supplied, so a contradiction is the client's to fix.
     */
    let effectiveCountry: string | null = countryCode ?? null;
    if (effectiveCountry === null && input.timezone !== undefined) {
      const current = await this.repository.findByFamilyId(familyId);
      if (!current) throw new NotFoundException('Family not found.');
      effectiveCountry = current.countryCode;
    }

    const timezone = await this.countries.reconcileTimeZone({
      countryCode: effectiveCountry,
      timezone: input.timezone !== undefined ? canonicalTimeZone(input.timezone) : undefined,
      enforce: true,
    });

    const normalised: IUpdateFamilySettingsInput = {
      ...input,
      ...(countryCode !== undefined ? { countryCode } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };

    const updated = await this.repository.update(familyId, normalised);

    // The cache is now invalidated whenever the STORED zone changed, which
    // includes the case where the client sent no timezone at all and the
    // country derived one for it. Keying this on `input.timezone` alone would
    // have left a family that has just moved to Riyadh reading Cairo's calendar
    // for five more minutes.
    if (timezone !== undefined) this.familyDate.invalidate(familyId);
    return updated;
  }
}
