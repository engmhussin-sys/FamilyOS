import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';

/**
 * PHASE D (`PD-N-002`) — WHAT A PUSH ATTEMPT ACTUALLY RESULTED IN.
 *
 * Before Phase D this service returned `void` and swallowed every error into a
 * `logger.warn`. Three genuinely different outcomes were therefore
 * indistinguishable to every caller:
 *
 *   the message was accepted by FCM;
 *   FCM was unreachable / rate-limited / internally broken — RETRY;
 *   the token is dead and will never work again — STOP.
 *
 * Retrying the third class forever is how a queue fills with rows that cannot
 * succeed; not retrying the second class is how a five-minute FCM outage
 * silently costs a night of notifications. The distinction is the whole point
 * of this type.
 */
export type PushSendOutcome =
  /** FCM accepted the message. */
  | 'SENT'
  /** Not configured in this environment — a documented no-op, not a failure. */
  | 'SKIPPED'
  /** Transient: the caller SHOULD retry with backoff. */
  | 'RETRYABLE'
  /** Terminal for this token: the caller must NOT retry. */
  | 'PERMANENT';

export interface PushSendResult {
  readonly outcome: PushSendOutcome;
  /** FCM's own error code when there was one, for `last_error`. Never the token. */
  readonly errorCode?: string;
}

/**
 * FCM's terminal error codes — the ones for which a retry is guaranteed to fail
 * again. Enumerated as a NAMED SET rather than matched with `includes('token')`
 * so that adding one is a deliberate edit, and so that an unrecognised code
 * falls into RETRYABLE.
 *
 * THE DEFAULT DIRECTION IS RETRY, and that is the safe direction: an unknown
 * code treated as permanent loses a notification that might have been
 * deliverable; treated as retryable it costs at most eight attempts and then
 * becomes a visible DEAD row an operator can read. Losing the message is the
 * failure this phase exists to remove, so the ambiguity resolves towards
 * keeping it.
 */
const PERMANENT_FCM_CODES: ReadonlySet<string> = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
  'messaging/invalid-recipient',
  'messaging/mismatched-credential',
  'messaging/invalid-package-name',
]);

/**
 * Sprint 5 (Push Notifications) — CLOSES A REAL GAP: `Device.pushToken`
 * has existed in the schema since an early sprint, and `auth/pairing.service.ts`
 * even already WRITES it during device confirmation — but zero code
 * anywhere ever READ it to actually send a push notification. This is
 * that missing send path.
 *
 * HONEST LIMITATION, STATED PLAINLY, same pattern as Sentry's own
 * integration this sprint: `firebase-admin` requires a real Firebase
 * project's service account credentials — a real external account
 * this environment cannot create. Without `FIREBASE_SERVICE_ACCOUNT_JSON`
 * set, this service logs a warning once and every send becomes a
 * documented no-op, never a crash — the rest of the alert pipeline
 * (in-app Notification row, Sentry, correlationId) continues to work
 * exactly as it did before this sprint.
 *
 * PHASE D CHANGED ONE THING AND ONLY ONE: the return type. The behaviour on
 * every existing path is identical — a failure is still caught, still logged
 * and still never thrown at the caller — but the caller can now TELL WHAT
 * HAPPENED. «A device is offline for days» was previously eight identical log
 * lines and no state; it is now a classified outcome that
 * `notification_deliveries` turns into eight attempts with doubling backoff and
 * then a visible DEAD row.
 */
@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);
  private isConfigured = false;

  onModuleInit(): void {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not set — push notifications will be logged but not actually sent. ' +
          'This is expected until a real Firebase project is configured; see PushNotificationService’s own docstring.',
      );
      return;
    }

    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      this.isConfigured = true;
    } catch (error) {
      // A malformed credential is a real misconfiguration worth a
      // loud warning, not a silent swallow — but still not fatal to
      // the whole backend starting up (same reasoning as Sentry: one
      // broken observability integration should never take down the
      // core product).
      this.logger.error('Failed to initialize firebase-admin — push notifications disabled.', error);
    }
  }

  /**
   * Best-effort at the TRANSPORT level and reported at the CALLER level.
   *
   * It still never throws — a push failure must never block or fail the
   * caller's own operation, which is this codebase's standing rule for
   * everything notification-adjacent. What is new is that «never throws» no
   * longer means «never tells»: the result says whether the caller should try
   * again, and this method is the one place that answer is decided.
   */
  async sendToDevice(
    pushToken: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushSendResult> {
    if (!this.isConfigured) {
      this.logger.debug(
        `[no-op, Firebase not configured] Would send push "${title}" to token ending in ...${pushToken.slice(-6)}`,
      );
      return { outcome: 'SKIPPED' };
    }

    try {
      await admin.messaging().send({
        token: pushToken,
        notification: { title, body },
        data,
      });
      return { outcome: 'SENT' };
    } catch (error) {
      const code = errorCodeOf(error);
      const outcome: PushSendOutcome = PERMANENT_FCM_CODES.has(code) ? 'PERMANENT' : 'RETRYABLE';
      // The token TAIL only, never the token: a push token in a log line is a
      // credential in a log line (CONTEXT §3 principle 8).
      this.logger.warn(
        `push.send_failed outcome=${outcome} code=${code} token=...${pushToken.slice(-6)}`,
      );
      return { outcome, errorCode: code };
    }
  }
}

/** firebase-admin puts its code on `.code`; anything else degrades to a name we
 * can still put in `last_error` without inventing one. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error ? error.name : 'unknown';
}

/** Exported for the test that asserts the permanent set stays a deliberate
 * named list rather than a substring match. */
export const PERMANENT_PUSH_ERROR_CODES = PERMANENT_FCM_CODES;
