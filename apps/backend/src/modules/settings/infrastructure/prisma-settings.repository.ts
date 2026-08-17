import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  IFamilySettings,
  ISettingsRepository,
  IUpdateFamilySettingsInput,
} from '../domain/settings.types';

@Injectable()
export class PrismaSettingsRepository implements ISettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByFamilyId(familyId: string): Promise<IFamilySettings | null> {
    const family = await this.prisma.family.findUnique({ where: { id: familyId } });
    return family ? this.toSettings(family) : null;
  }

  async update(familyId: string, input: IUpdateFamilySettingsInput): Promise<IFamilySettings> {
    const family = await this.prisma.family.update({ where: { id: familyId }, data: input });
    return this.toSettings(family);
  }

  private toSettings(family: {
    id: string;
    name: string;
    timezone: string;
    countryCode: string | null;
    subscriptionPlan: string;
  }): IFamilySettings {
    return {
      id: family.id,
      name: family.name,
      timezone: family.timezone,
      // F1. `GET /settings` now ECHOES the country. Until this line the column
      // could be written and never read back — the shape of an orphan field,
      // which is exactly the state `Family.timezone` was in before B2.
      countryCode: family.countryCode,
      subscriptionPlan: family.subscriptionPlan,
    };
  }
}
