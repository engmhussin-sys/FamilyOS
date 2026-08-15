/**
 * B3 — the shaping rules, exhaustively, without an HTTP server.
 *
 * `error-contract.e2e.spec.ts` proves the contract over a real socket; this
 * proves the decision table underneath it, including the branches that are
 * awkward to provoke through a controller (a null body, a body whose `message`
 * is neither string nor array, a details tree deeper than the depth cap).
 */
import { shapeErrorResponse } from '../../src/common/errors/error-response';
import { CODE_CATALOGUE, STATUS_FALLBACK } from '../../src/common/errors/error-catalogue';

const BASE = {
  correlationId: 'req-1',
  path: '/api/v1/x',
  timestamp: '2026-08-15T09:00:00.000Z',
};

const http = (status: number, body: unknown, fallbackMessage?: string) =>
  shapeErrorResponse({ ...BASE, status, body, fallbackMessage, isHttpException: true });

const raw = (status = 500) => shapeErrorResponse({ ...BASE, status, isHttpException: false });

describe('shapeErrorResponse — precedence', () => {
  it('a thrown `messageAr` beats the catalogue, always — interpolated counters survive', () => {
    const out = http(409, {
      code: 'REWARD_LIMIT_REACHED',
      messageAr: 'أكملت هذا البرنامج 3 مرات اليوم — وهذا هو الحد اليومي. نراك غدًا!',
    });

    expect(out.messageAr).toContain('3 مرات');
    expect(out.messageAr).not.toBe(CODE_CATALOGUE.REWARD_LIMIT_REACHED.messageAr);
  });

  it('the catalogue fills in when a code is thrown without Arabic', () => {
    const out = http(409, { code: 'REWARD_ALREADY_GRANTED' });
    expect(out.messageAr).toBe('تم احتساب هذه المكافأة بالفعل.');
    expect(out.message).toBe('This reward has already been counted.');
  });

  it('the status fallback fills in when neither is present', () => {
    const out = http(403, 'You do not have permission to set policies for this organization.');
    expect(out.code).toBe('UNAUTHORIZED_ACTION');
    expect(out.messageAr).toBe(STATUS_FALLBACK[403].messageAr);
    expect(out.message).toBe('You do not have permission to set policies for this organization.');
  });

  it('an unknown status still produces a code and Arabic rather than an empty field', () => {
    const out = http(418, { code: 'TEAPOT' });
    expect(out.code).toBe('TEAPOT');
    expect(out.messageAr).toBe('تعذّر إتمام هذا الطلب. حاول مرة أخرى.');
  });
});

describe('shapeErrorResponse — `message` backward compatibility', () => {
  it('passes a `string[]` straight through (the admin dashboard joins it)', () => {
    const out = http(400, { code: 'VALIDATION_FAILED', message: ['a must be a string', 'b must be an int'] });
    expect(out.message).toEqual(['a must be a string', 'b must be an int']);
  });

  it.each([
    [409, 'Conflict Exception'],
    [404, 'Not Found Exception'],
    [400, 'Bad Request Exception'],
    [422, 'Unprocessable Entity Exception'],
    [403, 'Forbidden Exception'],
  ])('rejects Nest’s class-derived text for %i — "%s" is never a message', (status, nestText) => {
    const out = http(status, { code: 'SOME_DOMAIN_CODE', messageAr: 'نصّ عربي.' }, nestText);
    expect(out.message).toBe(STATUS_FALLBACK[status].messageEn);
    expect(JSON.stringify(out)).not.toContain('Exception');
  });

  it('accepts a real `exception.message` that is NOT class-derived', () => {
    const out = http(409, { code: 'SOMETHING' }, 'This device is already paired.');
    expect(out.message).toBe('This device is already paired.');
  });

  it('handles a null / non-object body without throwing', () => {
    expect(http(404, null).code).toBe('NOT_FOUND');
    expect(http(404, 42).messageAr.length).toBeGreaterThan(0);
  });
});

describe('shapeErrorResponse — `details`', () => {
  it('promotes non-reserved keys off a coded body', () => {
    const out = http(400, { code: 'DEVICE_CLOCK_SKEW', message: 'skew', serverTime: '2026-08-15T09:00:00.000Z' });
    expect(out.details).toEqual({ serverTime: '2026-08-15T09:00:00.000Z' });
  });

  it('prefers an explicit `details` object when the thrower supplied one', () => {
    const out = http(400, { code: 'VALIDATION_FAILED', details: { fields: [{ field: 'name' }] }, other: 'ignored' });
    expect(out.details).toEqual({ fields: [{ field: 'name' }] });
    expect((out.details as Record<string, unknown>).other).toBeUndefined();
  });

  it('is EMPTY for an uncoded body — no unreviewed key can appear', () => {
    expect(http(400, { message: 'plain', internalTable: 'users' }).details).toEqual({});
  });

  it('is EMPTY for any 5xx, even a coded one', () => {
    expect(http(503, { code: 'SERVICE_UNAVAILABLE', providerHost: 'internal.paymob.local' }).details).toEqual({});
  });

  it('drops secret-looking keys at any depth', () => {
    const out = http(400, {
      code: 'X',
      safe: 'keep',
      accessToken: 'aaa',
      nested: { refreshToken: 'bbb', password: 'ccc', apiKey: 'ddd', keep: 1 },
    });
    expect(out.details).toEqual({ safe: 'keep', nested: { keep: 1 } });
  });

  it('drops an Error (and therefore its stack) wherever it appears', () => {
    const out = http(400, { code: 'X', cause: new Error('at Object.<anonymous> (/src/thing.ts:12:3)') });
    expect(out.details).toEqual({});
    expect(JSON.stringify(out)).not.toContain('thing.ts');
  });

  it('bounds depth, array length and string length', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const out = http(400, { code: 'X', deep, list: Array.from({ length: 200 }, (_, i) => i), long: 'x'.repeat(2000) });

    expect(JSON.stringify(out.details)).not.toContain('too deep');
    expect((out.details as any).list).toHaveLength(50);
    expect((out.details as any).long.length).toBeLessThanOrEqual(513);
  });
});

describe('shapeErrorResponse — the non-HttpException path', () => {
  it('says nothing about the error and carries an empty `details`', () => {
    const out = raw();
    expect(out.code).toBe('INTERNAL_ERROR');
    expect(out.message).toBe(STATUS_FALLBACK[500].messageEn);
    expect(out.messageAr).toBe(STATUS_FALLBACK[500].messageAr);
    expect(out.details).toEqual({});
  });

  it('always carries requestId === correlationId, plus every backward-compatible field', () => {
    const out = raw();
    expect(out.requestId).toBe('req-1');
    expect(out.correlationId).toBe('req-1');
    expect(out.statusCode).toBe(500);
    expect(out.timestamp).toBe('2026-08-15T09:00:00.000Z');
    expect(out.path).toBe('/api/v1/x');
  });
});

describe('the catalogue itself is non-punitive (CONTEXT §3 principle 7)', () => {
  const PUNITIVE = ['ممنوع', 'تجاوزت', 'حظر', 'محظور', 'خطؤك', 'أنت مخطئ'];

  it('no Arabic sentence in the status fallbacks scolds', () => {
    for (const entry of Object.values(STATUS_FALLBACK)) {
      for (const word of PUNITIVE) expect(entry.messageAr).not.toContain(word);
      expect(entry.messageAr.length).toBeGreaterThan(0);
    }
  });

  it('no Arabic sentence in the code catalogue scolds', () => {
    for (const entry of Object.values(CODE_CATALOGUE)) {
      for (const word of PUNITIVE) expect(entry.messageAr).not.toContain(word);
      expect(entry.messageAr.length).toBeGreaterThan(0);
      expect(entry.messageEn.length).toBeGreaterThan(0);
    }
  });

  it('the four codes the client contract names are all present with their agreed Arabic', () => {
    expect(CODE_CATALOGUE.REWARD_ALREADY_GRANTED.messageAr).toBe('تم احتساب هذه المكافأة بالفعل.');
    expect(CODE_CATALOGUE.REWARD_LIMIT_REACHED.messageAr).toBe('لقد وصلت إلى الحد المسموح من هذه المكافأة اليوم.');
    expect(CODE_CATALOGUE.ACHIEVEMENT_NOT_VERIFIED.messageAr).toBe('لم يتم التحقق من الإنجاز بعد.');
    expect(CODE_CATALOGUE.UNAUTHORIZED_ACTION.messageAr).toBe('ليس لديك صلاحية لتنفيذ هذا الإجراء.');
  });
});
