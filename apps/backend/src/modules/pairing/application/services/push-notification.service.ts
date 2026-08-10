import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';

/**
 * Sprint 5 (Push Notifications) — CLOSES A REAL GAP: `Device.pushToken`
 * has existed in the schema since an early sprint, and `auth/pairing.service.ts`
 * even already WRITES it during device confirmation \u2014 but zero code
 * anywhere ever READ it to actually send a push notification. This is
 * that missing send path.
 *
 * HONEST LIMITATION, STATED PLAINLY, same pattern as Sentry's own
 * integration this sprint: `firebase-admin` requires a real Firebase
 * project's service account credentials \u2014 a real external account
 * this environment cannot create. Without `FIREBASE_SERVICE_ACCOUNT_JSON`
 * set, this service logs a warning once and every send becomes a
 * documented no-op, never a crash \u2014 the rest of the alert pipeline
 * (in-app Notification row, Sentry, correlationId) continues to work
 * exactly as it did before this sprint.
 */
@Injectable()
export class PushNotificationService implements OnModuleInit {
  private readonly logger = new Logger(PushNotificationService.name);
  private isConfigured = false;

  onModuleInit(): void {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
      this.logger.warn(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not set \u2014 push notifications will be logged but not actually sent. ' +
          'This is expected until a real Firebase project is configured; see PushNotificationService\u2019s own docstring.',
      );
      return;
    }

    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      this.isConfigured = true;
    } catch (error) {
      // A malformed credential is a real misconfiguration worth a
      // loud warning, not a silent swallow \u2014 but still not fatal to
      // the whole backend starting up (same reasoning as Sentry: one
      // broken observability integration should never take down the
      // core product).
      this.logger.error('Failed to initialize firebase-admin \u2014 push notifications disabled.', error);
    }
  }

  /** Best-effort, matching every other notification-adjacent call in
   * this codebase (RuntimeAlertService, etc.) \u2014 a push delivery
   * failure must never block or fail the caller's own operation. */
  async sendToDevice(pushToken: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
    if (!this.isConfigured) {
      this.logger.debug(`[no-op, Firebase not configured] Would send push "${title}" to token ending in ...${pushToken.slice(-6)}`);
      return;
    }

    try {
      await admin.messaging().send({
        token: pushToken,
        notification: { title, body },
        data,
      });
    } catch (error) {
      this.logger.warn(`Push notification send failed for token ending in ...${pushToken.slice(-6)}`, error);
    }
  }
}
