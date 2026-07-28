import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { ChildrenModule } from '../children/children.module';

import { AuthController } from './presentation/controllers/auth.controller';
import { DevicePairingController } from './presentation/controllers/device-pairing.controller';
import { JwtStrategy } from './presentation/strategies/jwt.strategy';
import { DeviceJwtStrategy } from './presentation/strategies/device-jwt.strategy';

import { AuthService } from './application/services/auth.service';
import { TokenService } from './application/services/token.service';
import { PasswordService } from './application/services/password.service';
import { PairingService } from './application/services/pairing.service';

import { PrismaUserRepository } from './infrastructure/repositories/prisma-user.repository';
import { PrismaRefreshTokenRepository } from './infrastructure/repositories/prisma-refresh-token.repository';
import { PrismaDeviceRepository } from './infrastructure/repositories/prisma-device.repository';
import {
  USER_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  DEVICE_REPOSITORY,
} from './application/ports/auth.repository.ports';

@Module({
  imports: [
    PassportModule,
    ChildrenModule,
    // JwtModule is registered without global secret/expiry options —
    // TokenService and the two Passport strategies each pass their own
    // secret/expiresIn per call, since access and refresh tokens use
    // different secrets. Registering here mainly gives us JwtService/
    // Passport wiring, not shared config.
    JwtModule.register({}),
  ],
  controllers: [AuthController, DevicePairingController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    PairingService,
    JwtStrategy,
    DeviceJwtStrategy,
    // Dependency-inversion wiring: application services depend on the
    // IUserRepository/IRefreshTokenRepository/IDeviceRepository *ports*;
    // these bindings are the only place that knows the concrete
    // implementation is Prisma-based.
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },
    { provide: DEVICE_REPOSITORY, useClass: PrismaDeviceRepository },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
