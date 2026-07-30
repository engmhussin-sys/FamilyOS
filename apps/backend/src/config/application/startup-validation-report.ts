import { SecretsValidator } from './secrets-validator';
import { EnvironmentValidator } from './environment-validator';
import type { IConfigValidationIssue, IStartupValidationReport } from '../domain/configuration.types';

/**
 * Sprint 9's ConfigurationModule core. Composes SecretsValidator +
 * EnvironmentValidator into one report. Two consumers:
 *   1. `env.validation.ts` (ConfigModule's `validate` option) \u2014 throws
 *      if any FATAL issue exists, unchanged boot-time behavior, now
 *      backed by this richer check set instead of four inline checks.
 *   2. `SystemDiagnosticsController` \u2014 exposes the same report
 *      read-only after boot (WARNING issues visible without exposing
 *      the actual secret values themselves \u2014 see that controller).
 */
export class StartupValidationReport {
  private readonly secretsValidator = new SecretsValidator();
  private readonly environmentValidator = new EnvironmentValidator();

  build(env: NodeJS.ProcessEnv): IStartupValidationReport {
    const issues: IConfigValidationIssue[] = [
      ...this.secretsValidator.validate(env),
      ...this.environmentValidator.validate(env),
    ];

    return {
      isValid: !issues.some((i) => i.severity === 'FATAL'),
      checkedAt: new Date().toISOString(),
      issues,
    };
  }
}
