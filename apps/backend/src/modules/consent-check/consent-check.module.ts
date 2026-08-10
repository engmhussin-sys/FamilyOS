import { Module } from '@nestjs/common';

import { ConsentCheckService } from './application/consent-check.service';

/**
 * Deliberately has NO `imports` array at all — see
 * ConsentCheckService's own docstring for why that's the whole point
 * of this module's existence (breaking a real circular-dependency
 * risk between compliance and life-intelligence).
 */
@Module({
  providers: [ConsentCheckService],
  exports: [ConsentCheckService],
})
export class ConsentCheckModule {}
