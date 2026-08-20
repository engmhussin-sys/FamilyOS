import { Injectable } from '@nestjs/common';
import type { RefreshToken } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  ICreateRefreshTokenInput,
  IRefreshTokenRepository,
} from '../../application/ports/auth.repository.ports';

@Injectable()
export class PrismaRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: ICreateRefreshTokenInput): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({
      data: {
        id: input.jti, // use the JWT's jti as the row's primary key: one lookup, no separate mapping needed
        userId: input.userId,
        deviceId: input.deviceId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        familyTokenId: input.familyTokenId,
      },
    });
  }

  findActiveByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  findAnyByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    // tokenHash is @unique, so findUnique is exact and index-backed.
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async revokeFamily(familyTokenId: string, revokedAt: Date): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { familyTokenId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async markReplacedBy(id: string, replacedById: string): Promise<void> {
    await this.prisma.refreshToken.update({ where: { id }, data: { replacedById } });
  }

  async revokeById(id: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.update({ where: { id }, data: { revokedAt } });
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAllForDevice(deviceId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt },
    });
  }
}
