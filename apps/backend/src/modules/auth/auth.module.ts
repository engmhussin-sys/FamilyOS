import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { ChildrenModule } from '../children/children.module';
import { GrowthCaptureModule } from '../analytics/growth-capture.module';

import { AuthController } from './presentation/controllers/auth.controller';
import { JwtStrategy } from './presentation/strategies/jwt.strategy';
import { DeviceJwtStrategy } from './presentation/strategies/device-jwt.strategy';

import { AuthService } from './application/services/auth.service';
import { TokenService } from './application/services/token.service';
import { PasswordService } from './application/services/password.service';

import { PrismaUserRepository } from './infrastructure/repositories/prisma-user.repository';
import { PrismaRefreshTokenRepository } from './infrastructure/repositories/prisma-refresh-token.repository';
import {
  USER_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
} from './application/ports/auth.repository.ports';

@Module({
  imports: [
    PassportModule,
    ChildrenModule,
    // PHASE D (GROWTH). The CAPTURE half only — it imports nothing, so this
    // cannot create the Auth -> Analytics -> Events -> Pairing -> Auth cycle
    // that importing the full AnalyticsModule would.
    GrowthCaptureModule,
    // JwtModule is registered without global secret/expiry options —
    // TokenService and the two Passport strategies each pass their own
    // secret/expiresIn per call, since access and refresh tokens use
    // different secrets. Registering here mainly gives us JwtService/
    // Passport wiring, not shared config.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    JwtStrategy,
    DeviceJwtStrategy,
    // Dependency-inversion wiring: application services depend on the
    // IUserRepository/IRefreshTokenRepository *ports*;
    // these bindings are the only place that knows the concrete
    // implementation is Prisma-based.
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },
  ],
  exports: [AuthService, TokenService, PasswordService, USER_REPOSITORY],
})
export class AuthModule {}
