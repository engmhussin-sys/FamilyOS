import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  IProfileRepository,
  IUpdateProfileInput,
  IUserProfile,
} from '../domain/profile.types';

const SUPPORTED_LOCALES = new Set(['en', 'ar']);

@Injectable()
export class PrismaProfileRepository implements IProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(userId: string): Promise<IUserProfile | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user ? this.toProfile(user) : null;
  }

  async update(userId: string, input: IUpdateProfileInput): Promise<IUserProfile> {
    if (input.locale && !SUPPORTED_LOCALES.has(input.locale)) {
      // Same "reject at the boundary, don't silently coerce" instinct
      // as every DTO validator in this project \u2014 an unsupported locale
      // string should fail loudly here too, not be silently stored and
      // fall back invisibly somewhere downstream.
      throw new NotFoundException(`Locale "${input.locale}" is not supported.`);
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: input,
    });
    return this.toProfile(user);
  }

  private toProfile(user: {
    id: string;
    email: string;
    fullName: string;
    phone: string | null;
    locale: string;
    timezone: string;
  }): IUserProfile {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      locale: user.locale,
      timezone: user.timezone,
    };
  }
}
