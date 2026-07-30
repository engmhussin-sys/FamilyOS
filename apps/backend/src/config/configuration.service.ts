import { Injectable } from '@nestjs/common';

import { StartupValidationReport } from './application/startup-validation-report';
import type { IStartupValidationReport } from './domain/configuration.types';

/** The DI-injectable form of StartupValidationReport \u2014 `env.validation.ts`
 * itself can't use DI (it runs before Nest's container exists), so that
 * file constructs `StartupValidationReport` directly; this service is
 * for every consumer AFTER boot (SystemDiagnosticsController). */
@Injectable()
export class ConfigurationService {
  private readonly report = new StartupValidationReport();

  getValidationReport(): IStartupValidationReport {
    return this.report.build(process.env);
  }
}
