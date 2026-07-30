import { StartupValidationReport } from './application/startup-validation-report';

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;

/**
 * Passed to ConfigModule.forRoot({ validate }). Runs once at process
 * startup. We intentionally fail hard (throw, crash the process) rather
 * than let the app boot in a half-configured state.
 *
 * Sprint 9: now backed by `StartupValidationReport` (SecretsValidator +
 * EnvironmentValidator) instead of four inline checks \u2014 the same report
 * shape is reused read-only by `SystemDiagnosticsController` after boot,
 * so "what did startup validation actually check" is answerable from
 * one place, not reimplemented twice.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_ENV_VARS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. See apps/backend/.env.example.`,
    );
  }

  const report = new StartupValidationReport().build(config as NodeJS.ProcessEnv);
  const fatalIssues = report.issues.filter((i) => i.severity === 'FATAL');
  if (fatalIssues.length > 0) {
    throw new Error(
      `Startup configuration validation failed:\n${fatalIssues.map((i) => `  - [${i.key}] ${i.message}`).join('\n')}`,
    );
  }

  return config;
}
