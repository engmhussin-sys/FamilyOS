import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { FamilyDateService } from '../../../common/time/family-date.service';
import { canonicalTimeZone } from '../../../common/time/family-date';
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
   */
  async updateSettings(familyId: string, input: IUpdateFamilySettingsInput) {
    const normalised: IUpdateFamilySettingsInput = {
      ...input,
      ...(input.timezone !== undefined ? { timezone: canonicalTimeZone(input.timezone) } : {}),
    };
    const updated = await this.repository.update(familyId, normalised);
    if (input.timezone !== undefined) this.familyDate.invalidate(familyId);
    return updated;
  }
}
