/**
 * B3 — THE GLOBAL ERROR CONTRACT: the shaping half.
 *
 * A pure function, deliberately separate from `GlobalExceptionFilter`, so the
 * contract can be asserted without constructing an `ArgumentsHost` — and so
 * the filter stays a thin adapter between Express and this.
 *
 * THE CONTRACT (additive — nothing that existed was removed or renamed):
 *
 *   {
 *     "statusCode": 409,                     // pre-existing
 *     "code": "MAX_PER_DAY_REACHED",         // NEW — machine-readable
 *     "message": "...",                      // pre-existing, English, unchanged semantics
 *     "messageAr": "...",                    // NEW — what a child/parent reads
 *     "details": {},                         // NEW — structured, opt-in
 *     "requestId": "8f0c…",                  // NEW — SAME value as correlationId
 *     "correlationId": "8f0c…",              // pre-existing
 *     "timestamp": "...",                    // pre-existing
 *     "path": "/api/v1/…"                    // pre-existing
 *   }
 *
 * WHY `requestId` IS NOT A NEW ID. F3 already threads one id end to end:
 * `CorrelationIdMiddleware` mints/accepts it, `TenantContextInterceptor` puts
 * it on the tenant context as `requestId`, `EventsController` returns it as
 * `meta.requestId`, `OutboxWriter` persists it as `domain_events.correlation_id`
 * and the relay republishes it as the envelope's `traceId`. Minting a second id
 * here would mean a support ticket quoting `requestId` could not be joined to
 * the log line, the outbox row, or the Sentry event. So `requestId` is an alias
 * of the existing correlation id, and both are emitted: `correlationId` because
 * the parent app already reads it (`api_client.dart:131`), `requestId` because
 * that is the name the rest of the API already uses.
 *
 * WHAT NEVER REACHES THE BODY, in any environment:
 *   - a stack trace,
 *   - the message of anything that is not an `HttpException` (Prisma errors,
 *     `TenantContextMissingError`, `TypeError`, …) — those become the generic
 *     500 text, exactly as before,
 *   - unrecognised keys off an exception body: `details` is populated ONLY from
 *     a body that deliberately declared a `code`, is dropped entirely for 5xx,
 *     is depth/size bounded, and is swept for secret-looking keys.
 */

import { catalogueFor, fallbackForStatus } from './error-catalogue';

export interface ErrorResponseBody {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string | string[];
  readonly messageAr: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly path: string;
}

/** Keys consumed by the contract itself — never repeated inside `details`. */
const RESERVED_BODY_KEYS = new Set([
  'code',
  'message',
  'messageAr',
  'details',
  'statusCode',
  'error',
  'timestamp',
  'path',
  'correlationId',
  'requestId',
]);

/**
 * Keys whose VALUE is dropped from `details` regardless of who put it there.
 * `details` is developer-controlled, so this is defence in depth rather than a
 * primary control — but the primary control (code review) has already failed
 * once in this exact area, which is what PA-B-021 was.
 */
const SECRET_KEY_PATTERN = /(token|password|secret|apikey|api_key|authorization|credential|cookie|signature|hash|salt|dsn|connectionstring|connection_string)/i;

const MAX_DETAILS_DEPTH = 4;
const MAX_DETAILS_ARRAY = 50;
const MAX_DETAILS_STRING = 512;

export interface ShapeErrorInput {
  readonly status: number;
  /** `exception.getResponse()` for an HttpException; `undefined` otherwise. */
  readonly body?: unknown;
  /** `exception.message` for an HttpException; `undefined` otherwise. */
  readonly fallbackMessage?: string;
  /** False for anything that is not an HttpException — forces the generic path. */
  readonly isHttpException: boolean;
  readonly correlationId: string;
  readonly path: string;
  readonly timestamp: string;
}

export function shapeErrorResponse(input: ShapeErrorInput): ErrorResponseBody {
  const status = input.status;
  const statusFallback = fallbackForStatus(status);

  const base = {
    statusCode: status,
    requestId: input.correlationId,
    correlationId: input.correlationId,
    timestamp: input.timestamp,
    path: input.path,
  };

  // ---------------------------------------------------------------------
  // 1. Not an HttpException. Nothing about it is safe to describe.
  // ---------------------------------------------------------------------
  if (!input.isHttpException) {
    return {
      ...base,
      code: statusFallback.code,
      message: statusFallback.messageEn,
      messageAr: statusFallback.messageAr,
      details: {},
    };
  }

  const body = input.body;

  // ---------------------------------------------------------------------
  // 2. `throw new NotFoundException('Habit not found')` — a bare string body.
  //    58 sites in this codebase. The English message is preserved verbatim
  //    (backward compatibility); the code and the Arabic come from the status.
  // ---------------------------------------------------------------------
  if (typeof body === 'string') {
    return {
      ...base,
      code: statusFallback.code,
      message: body,
      messageAr: statusFallback.messageAr,
      details: {},
    };
  }

  if (typeof body !== 'object' || body === null) {
    return {
      ...base,
      code: statusFallback.code,
      message: input.fallbackMessage ?? statusFallback.messageEn,
      messageAr: statusFallback.messageAr,
      details: {},
    };
  }

  const record = body as Record<string, unknown>;
  const declaredCode = typeof record.code === 'string' && record.code.length > 0 ? record.code : undefined;
  const entry = catalogueFor(declaredCode);

  const code = declaredCode ?? statusFallback.code;

  // ---------------------------------------------------------------------
  // 3. `messageAr` — the whole point of PA-B-021. Thrown value first, then
  //    the code catalogue, then the per-status sentence. Never empty.
  // ---------------------------------------------------------------------
  const messageAr =
    typeof record.messageAr === 'string' && record.messageAr.length > 0
      ? record.messageAr
      : (entry?.messageAr ?? statusFallback.messageAr);

  // ---------------------------------------------------------------------
  // 4. `message` — unchanged semantics for every existing consumer. Nest's
  //    ValidationPipe puts a `string[]` here and the admin dashboard joins it
  //    (`httpClient.ts:44`); that array is passed through untouched.
  // ---------------------------------------------------------------------
  const message = extractMessage(record, entry?.messageEn, input.fallbackMessage, statusFallback.messageEn);

  return {
    ...base,
    code,
    message,
    messageAr,
    details: buildDetails(record, declaredCode !== undefined, status),
  };
}

function extractMessage(
  record: Record<string, unknown>,
  catalogueEn: string | undefined,
  fallbackMessage: string | undefined,
  statusEn: string,
): string | string[] {
  const raw = record.message;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw.map((v) => String(v));
  if (catalogueEn) return catalogueEn;
  // `exception.message` is Nest's own humanised status text ("Conflict
  // Exception") when a structured body was thrown. It is a strictly worse
  // sentence than the catalogue's, so it is only used when there is no
  // catalogue entry at all — and even then the status sentence beats it.
  if (fallbackMessage && !isNestGeneratedMessage(fallbackMessage)) return fallbackMessage;
  return statusEn;
}

/**
 * Nest builds `exception.message` from the class name when the response body is
 * an object, splitting it on capitals: `ConflictException` -> "Conflict
 * Exception", `NotFoundException` -> "Not Found Exception",
 * `UnprocessableEntityException` -> "Unprocessable Entity Exception". Those
 * strings are exactly what production was returning to children (PA-B-021), so
 * they are recognised and rejected rather than allowed through as a "real"
 * message. A genuine sentence ("This device is already paired.") does not match:
 * every word must be capitalised and the last one must be "Exception".
 */
function isNestGeneratedMessage(message: string): boolean {
  return /^(?:[A-Z][A-Za-z]* )*Exception$/.test(message.trim());
}

/**
 * `details` is populated only from a body that deliberately declared a `code`.
 * A legacy free-text exception body contributes nothing — surfacing whatever
 * keys happened to be on it would be new, unreviewed exposure.
 *
 * For status >= 500 `details` is always empty: a 5xx describes a server fault,
 * and there is nothing about a server fault a client needs beyond `requestId`.
 */
function buildDetails(
  record: Record<string, unknown>,
  hasDeclaredCode: boolean,
  status: number,
): Readonly<Record<string, unknown>> {
  if (!hasDeclaredCode || status >= 500) return {};

  const explicit = record.details;
  const source =
    typeof explicit === 'object' && explicit !== null && !Array.isArray(explicit)
      ? (explicit as Record<string, unknown>)
      : pickExtraKeys(record);

  const sanitised = sanitise(source, 0);
  return (typeof sanitised === 'object' && sanitised !== null && !Array.isArray(sanitised)
    ? sanitised
    : {}) as Record<string, unknown>;
}

/**
 * Everything on the body that is not part of the contract. This is what keeps
 * `{ code: 'TARGET_SPEC_INVALID', errors: [...] }` and
 * `{ code: 'DEVICE_CLOCK_SKEW', serverTime: '...' }` useful to a client — both
 * were being thrown away entirely before B3.
 */
function pickExtraKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_BODY_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function sanitise(value: unknown, depth: number): unknown {
  if (depth > MAX_DETAILS_DEPTH) return undefined;

  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return value.length > MAX_DETAILS_STRING ? `${value.slice(0, MAX_DETAILS_STRING)}…` : value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  // An Error carries a stack. It never goes to a client, at any depth.
  if (value instanceof Error) return undefined;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DETAILS_ARRAY)
      .map((item) => sanitise(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    const cleaned = sanitise(item, depth + 1);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}
