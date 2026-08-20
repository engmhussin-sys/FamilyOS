import { EnvironmentValidator } from '../../src/config/application/environment-validator';

describe('EnvironmentValidator', () => {
  const validator = new EnvironmentValidator();

  const validBaseEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('flags a missing DATABASE_URL as FATAL', () => {
    const issues = validator.validate({ ...validBaseEnv, DATABASE_URL: undefined });
    expect(issues).toContainEqual(expect.objectContaining({ key: 'DATABASE_URL', severity: 'FATAL' }));
  });

  it('flags a malformed DATABASE_URL scheme as FATAL', () => {
    const issues = validator.validate({ ...validBaseEnv, DATABASE_URL: 'mysql://localhost/db' });
    expect(issues).toContainEqual(expect.objectContaining({ key: 'DATABASE_URL', severity: 'FATAL' }));
  });

  it('accepts a well-formed DATABASE_URL/REDIS_URL with zero FATAL issues for those keys', () => {
    const issues = validator.validate(validBaseEnv);
    expect(issues.filter((i) => i.severity === 'FATAL')).toHaveLength(0);
  });

  describe('Sprint 4/5 additions: SENTRY_DSN / FIREBASE_SERVICE_ACCOUNT_JSON', () => {
    it('warns (not FATAL) when SENTRY_DSN is missing — matches the safe-no-op behavior it actually has', () => {
      const issues = validator.validate(validBaseEnv);
      expect(issues).toContainEqual(expect.objectContaining({ key: 'SENTRY_DSN', severity: 'WARNING' }));
    });

    it('does NOT warn about SENTRY_DSN when it is set', () => {
      const issues = validator.validate({ ...validBaseEnv, SENTRY_DSN: 'https://real@sentry.io/123' });
      expect(issues.find((i) => i.key === 'SENTRY_DSN')).toBeUndefined();
    });

    it('warns when FIREBASE_SERVICE_ACCOUNT_JSON is missing', () => {
      const issues = validator.validate(validBaseEnv);
      expect(issues).toContainEqual(expect.objectContaining({ key: 'FIREBASE_SERVICE_ACCOUNT_JSON', severity: 'WARNING' }));
    });

    it('warns when FIREBASE_SERVICE_ACCOUNT_JSON is set but not valid JSON — catches a real, easy-to-make paste error', () => {
      const issues = validator.validate({ ...validBaseEnv, FIREBASE_SERVICE_ACCOUNT_JSON: 'not-json{{{' });
      expect(issues).toContainEqual(
        expect.objectContaining({ key: 'FIREBASE_SERVICE_ACCOUNT_JSON', severity: 'WARNING', message: expect.stringContaining('not valid JSON') }),
      );
    });

    it('does NOT warn when FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON', () => {
      const issues = validator.validate({
        ...validBaseEnv,
        FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'test', private_key: 'x', client_email: 'x@x.iam.gserviceaccount.com' }),
      });
      expect(issues.find((i) => i.key === 'FIREBASE_SERVICE_ACCOUNT_JSON')).toBeUndefined();
    });

    it('none of these new checks are ever FATAL — both integrations must degrade gracefully, never block boot', () => {
      const issues = validator.validate(validBaseEnv);
      const newIssues = issues.filter((i) => i.key === 'SENTRY_DSN' || i.key === 'FIREBASE_SERVICE_ACCOUNT_JSON');
      expect(newIssues.every((i) => i.severity === 'WARNING')).toBe(true);
    });
  });

  describe('B8 (PA-B-027): the provider chain’s secondary ring', () => {
    it('warns when Anthropic is configured but OpenAI is not — failover you do not have', () => {
      const issues = validator.validate({ ...validBaseEnv, ANTHROPIC_API_KEY: 'sk-ant-real' });
      const issue = issues.find((i) => i.key === 'OPENAI_API_KEY');
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe('WARNING');
      expect(issue!.message).toContain('NO secondary ring');
    });

    it('is silent once BOTH rings are configured', () => {
      const issues = validator.validate({
        ...validBaseEnv,
        ANTHROPIC_API_KEY: 'sk-ant-real',
        OPENAI_API_KEY: 'sk-openai-real',
      });
      expect(issues.find((i) => i.key === 'OPENAI_API_KEY')).toBeUndefined();
    });

    it('does not nag about a fallback when there is no primary either — one warning, not two', () => {
      // A deployment with no AI at all already gets the ANTHROPIC_API_KEY
      // warning; adding a second about the ring behind it is noise, and noise
      // is how a WARNING list stops being read.
      const issues = validator.validate(validBaseEnv);
      expect(issues.find((i) => i.key === 'ANTHROPIC_API_KEY')).toBeDefined();
      expect(issues.find((i) => i.key === 'OPENAI_API_KEY')).toBeUndefined();
    });

    it('never raises a FATAL for either provider — single-provider is supported', () => {
      const issues = validator.validate({ ...validBaseEnv, ANTHROPIC_API_KEY: 'sk-ant-real' });
      expect(issues.filter((i) => i.severity === 'FATAL')).toHaveLength(0);
    });
  });
});
