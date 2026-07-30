import { Global, Module } from '@nestjs/common';

import { ConfigurationService } from './configuration.service';

/** Global \u2014 same reasoning as PrismaModule/RedisModule: every module
 * that might need to report its own config health (Readiness Checklist
 * Engine, System Diagnostics) needs this without each importing it
 * explicitly. */
@Global()
@Module({
  providers: [ConfigurationService],
  exports: [ConfigurationService],
})
export class ConfigurationModule {}
