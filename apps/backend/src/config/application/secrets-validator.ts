import type { IConfigValidationIssue } from '../domain/configuration.types';

/**
 * Sprint 9. Split out from the general environment checks below because
 * "is this a well-formed URL" and "is this secret strong enough" are
 * different failure classes worth naming separately in a startup report
 * \u2014 a weak secret should never be confused with a missing config value
 * when someone is reading the boot log.
 */
export class SecretsValidator {
  validate(env: NodeJS.ProcessEnv): IConfigValidationIssue[] {
    const issues: IConfigValidationIssue[] = [];

    const accessSecret = env.JWT_ACCESS_SECRET;
    const refreshSecret = env.JWT_REFRESH_SECRET;

    if (!accessSecret) {
      issues.push({ key: 'JWT_ACCESS_SECRET', severity: 'FATAL', message: 'Missing.' });
    } else if (accessSecret.length < 32) {
      issues.push({ key: 'JWT_ACCESS_SECRET', severity: 'FATAL', message: 'Must be at least 32 characters.' });
    }

    if (!refreshSecret) {
      issues.push({ key: 'JWT_REFRESH_SECRET', severity: 'FATAL', message: 'Missing.' });
    } else if (refreshSecret.length < 32) {
      issues.push({ key: 'JWT_REFRESH_SECRET', severity: 'FATAL', message: 'Must be at least 32 characters.' });
    }

    if (accessSecret && refreshSecret && accessSecret === refreshSecret) {
      issues.push({
        key: 'JWT_ACCESS_SECRET/JWT_REFRESH_SECRET',
        severity: 'FATAL',
        message: 'Access and refresh secrets must be different values.',
      });
    }

    if (!env.LOCATION_ENCRYPTION_KEY) {
      issues.push({ key: 'LOCATION_ENCRYPTION_KEY', severity: 'WARNING', message: 'Missing \u2014 location-related features will fail if used.' });
    }

    return issues;
  }
}
