import type { IConfigValidationIssue } from '../domain/configuration.types';

const VALID_AI_MODELS_PREFIX = 'claude-'; // this backend has exactly one AI provider integration today (Anthropic) \u2014 see AnthropicAIProvider

/**
 * Sprint 9. Checks that configured values are well-formed and point at
 * something real \u2014 distinct from SecretsValidator's "is this strong
 * enough" concern. Every check here maps to a real dependency this
 * backend actually has (DATABASE_URL, REDIS_URL, the one AI provider) \u2014
 * no placeholder checks for providers that don't exist (no storage
 * provider, no push-notification provider are integrated in this
 * codebase yet, so there is nothing to validate for them; adding a
 * check for a provider with zero implementation would be a check that
 * can never meaningfully fail or pass).
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
      // Not FATAL \u2014 AnthropicAIProvider already degrades gracefully
      // (AiCoreOrchestratorService throws a scoped exception only when
      // an AI feature is actually called, not at boot) \u2014 matches
      // Decision-069's "system must remain functional without any
      // external provider" for the six non-LLM-dependent AI engines.
      issues.push({
        key: 'ANTHROPIC_API_KEY',
        severity: 'WARNING',
        message: 'Missing \u2014 AI Assistant/Diagnostics/Recommendation phrasing will degrade to deterministic fallback text.',
      });
    }

    if (!env.CORS_ALLOWED_ORIGINS) {
      issues.push({
        key: 'CORS_ALLOWED_ORIGINS',
        severity: 'WARNING',
        message: 'Missing \u2014 CORS will allow no origins at all (main.ts defaults to an empty array), not a security hole but likely unintended.',
      });
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
