const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

/**
 * Passed to ConfigModule.forRoot({ validate }). Runs once at process
 * startup. We intentionally fail hard (throw, crash the process) rather
 * than let the app boot in a half-configured state — a service that starts
 * without JWT secrets is a service that will fail unpredictably per-request
 * instead of loudly at deploy time.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_ENV_VARS.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'See apps/backend/.env.example.',
    );
  }

  const accessSecret = String(config.JWT_ACCESS_SECRET);
  const refreshSecret = String(config.JWT_REFRESH_SECRET);
  if (accessSecret === refreshSecret) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }
  if (accessSecret.length < 32 || refreshSecret.length < 32) {
    throw new Error('JWT secrets must be at least 32 characters long.');
  }

  return config;
}
