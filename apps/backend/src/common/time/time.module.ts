import { Global, Module } from '@nestjs/common';

import { FamilyDateService } from './family-date.service';

/**
 * `@Global` for the same reason `PrismaModule` is: "what day is it for this
 * family?" is asked by six modules and will be asked by the seventh. Making
 * each of them import a TimeModule would be ceremony that buys nothing, and the
 * first module that forgot would silently fall back to a second, wrong notion
 * of a day — which is exactly the failure B2 exists to remove.
 */
@Global()
@Module({
  providers: [FamilyDateService],
  exports: [FamilyDateService],
})
export class TimeModule {}
