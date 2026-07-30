import { Injectable } from '@nestjs/common';

const PII_KEYS = new Set(['email', 'phone', 'fullName', 'firstName', 'lastName', 'password', 'passwordHash']);
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * The Privacy Filter every event payload passes through before it
 * reaches the Event Store OR any external adapter \u2014 called from
 * EventCollectorService, not optionally from call sites (so it can't be
 * forgotten). Two layers: known PII key names are dropped outright;
 * string values are also scanned for an email pattern as a defense
 * against PII smuggled into a differently-named field.
 */
@Injectable()
export class PrivacyFilter {
  sanitize(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!payload) return payload;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (PII_KEYS.has(key)) continue; // dropped, not just redacted \u2014 the key never appears in the stored event

      if (typeof value === 'string' && EMAIL_PATTERN.test(value)) {
        result[key] = value.replace(EMAIL_PATTERN, '[redacted-email]');
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
