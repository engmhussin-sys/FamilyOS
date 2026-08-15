import type { IConfigValidationIssue } from '../domain/configuration.types';

const VALID_AI_MODELS_PREFIX = 'claude-'; // the PRIMARY ring of the provider chain (Anthropic) \u2014 see AnthropicAIProvider

/**
 * Sprint 9. Checks that configured values are well-formed and point at
 * something real — distinct from SecretsValidator's "is this strong
 * enough" concern. Every check here maps to a real dependency this
 * backend actually has.
 *
 * UPDATED (Sprints 4/5): the original version of this docstring said
 * "no push-notification provider is integrated in this codebase yet"
 * — that became stale the moment PushNotificationService/Sentry
 * shipped; SENTRY_DSN and FIREBASE_SERVICE_ACCOUNT_JSON are now
 * checked below with the exact same WARNING-not-FATAL pattern as
 * ANTHROPIC_API_KEY, since both integrations already degrade
 * gracefully to a safe no-op without their credentials.
 */
export class EnvironmentValidator {
  validate(env: NodeJS.ProcessEnv): IConfigValidationIssue[] {
    const issues: IConfigValidationIssue[] = [];

    issues.push(...this.checkUrl('DATABASE_URL', env.DATABASE_URL, ['postgresql:', 'postgres:']));
    issues.push(...this.checkUrl('REDIS_URL', env.REDIS_URL, ['redis:', 'rediss:']));

    if (env.ANTHROPIC_API_KEY && env.AI_ASSISTANT_MODEL && !env.AI_ASSISTANT_MODEL.startsWith(VALID_AI_MODELS_PREFIX)) {
      issues.push({
        key: 'AI_ASSISTANT_MODEL',
        severity: 'WARNING',
        message: `"${env.AI_ASSISTANT_MODEL}" doesn't look like an Anthropic model name (expected to start with "${VALID_AI_MODELS_PREFIX}").`,
      });
    }
    if (!env.ANTHROPIC_API_KEY) {
      issues.push({
        key: 'ANTHROPIC_API_KEY',
        severity: 'WARNING',
        message: 'Missing — AI Assistant/Diagnostics/Recommendation phrasing will degrade to deterministic fallback text.',
      });
    }

    // B8 (PA-B-027): the SECONDARY ring. A WARNING, never FATAL, and worded so
    // it is clear that running single-provider is a supported configuration —
    // `FallbackAiProvider` skips an unconfigured ring rather than failing it.
    // What is NOT supported silently is believing you have failover when you do
    // not, which is the state this backend was in before B8.
    if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
      issues.push({
        key: 'OPENAI_API_KEY',
        severity: 'WARNING',
        message:
          'Missing — the AI provider chain has NO secondary ring. An Anthropic outage will degrade every AI ' +
          'feature to deterministic text (safe) and will fail /ai-assistant/ask outright (a real outage). ' +
          'CONTEXT §2 specifies OpenAI as the fallback provider.',
      });
    }

    if (!env.CORS_ALLOWED_ORIGINS) {
      issues.push({
        key: 'CORS_ALLOWED_ORIGINS',
        severity: 'WARNING',
        message: 'Missing — CORS will allow no origins at all (main.ts defaults to an empty array), not a security hole but likely unintended.',
      });
    }

    if (!env.SENTRY_DSN) {
      issues.push({
        key: 'SENTRY_DSN',
        severity: 'WARNING',
        message: 'Missing — errors are still logged locally (GlobalExceptionFilter unchanged), just not reported to Sentry. See PRODUCTION_DEPLOYMENT_GUIDE.md.',
      });
    }

    if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      issues.push({
        key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
        severity: 'WARNING',
        message: 'Missing — PushNotificationService will log every send as a no-op rather than actually delivering it. See PRODUCTION_DEPLOYMENT_GUIDE.md.',
      });
    } else {
      try {
        JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      } catch {
        issues.push({
          key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
          severity: 'WARNING',
          message: 'Set, but not valid JSON — push notifications will fail to initialize. Expected the full Firebase service-account key, collapsed to one line.',
        });
      }
    }

    return issues;
  }

  private checkUrl(key: string, value: string | undefined, validSchemes: string[]): IConfigValidationIssue[] {
    if (!value) return [{ key, severity: 'FATAL', message: 'Missing.' }];
    try {
      const url = new URL(value);
      if (!validSchemes.includes(url.protocol)) {
        return [{ key, severity: 'FATAL', message: `Expected scheme ${validSchemes.join(' or ')}, got "${url.protocol}".` }];
      }
      return [];
    } catch {
      return [{ key, severity: 'FATAL', message: 'Not a valid URL.' }];
    }
  }
}
