import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  SETTINGS_REPOSITORY,
  type ISettingsRepository,
  type IUpdateFamilySettingsInput,
} from '../domain/settings.types';

@Injectable()
export class SettingsService {
  constructor(@Inject(SETTINGS_REPOSITORY) private readonly repository: ISettingsRepository) {}

  async getSettings(familyId: string) {
    const settings = await this.repository.findByFamilyId(familyId);
    if (!settings) {
      throw new NotFoundException('Family not found.');
    }
    return settings;
  }

  updateSettings(familyId: string, input: IUpdateFamilySettingsInput) {
    return this.repository.update(familyId, input);
  }
}
