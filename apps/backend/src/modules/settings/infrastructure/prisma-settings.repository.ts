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
    subscriptionPlan: string;
  }): IFamilySettings {
    return {
      id: family.id,
      name: family.name,
      timezone: family.timezone,
      subscriptionPlan: family.subscriptionPlan,
    };
  }
}
