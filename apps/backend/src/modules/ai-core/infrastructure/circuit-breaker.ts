/**
 * Sprint 9's AI Production Validation. Generic (not AI-specific) so any
 * future external-dependency call in this codebase can reuse it \u2014
 * placed in ai-core only because the LLM provider is this project's
 * one and only external-call site today.
 *
 * Classic three-state breaker:
 *   CLOSED (normal) \u2192 [failureThreshold consecutive failures] \u2192 OPEN
 *   OPEN \u2192 [cooldownMs elapses] \u2192 HALF_OPEN
 *   HALF_OPEN \u2192 [next call succeeds] \u2192 CLOSED
 *   HALF_OPEN \u2192 [next call fails] \u2192 OPEN (cooldown restarts)
 * While OPEN, calls fail IMMEDIATELY without attempting the underlying
 * call \u2014 the entire point is to stop hammering a provider that's
 * already down, not just to retry politely.
 */
export class CircuitBreakerOpenException extends Error {
  constructor() {
    super('Circuit breaker is open \u2014 the provider is assumed unavailable until the cooldown elapses.');
  }
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly cooldownMs: number = 30_000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.openedAt !== null && Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitBreakerOpenException();
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
    this.openedAt = null;
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}
