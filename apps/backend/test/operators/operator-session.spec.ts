import { createHash } from 'node:crypto';

import {
  OPERATOR_SESSION_TTL_SECONDS,
  OperatorSessionService,
} from '../../src/modules/operators/application/operator-session.service';
import type { RedisService } from '../../src/common/redis/redis.service';

/**
 * ===========================================================================
 * THE PROPERTY A JWT COULD NOT HAVE GIVEN US.
 * ===========================================================================
 *
 * The defect this sprint exists to fix is not that operator actions were
 * anonymous — it is that ONE PERSON'S ACCESS COULD NOT BE REMOVED without
 * removing everyone's. A stateless token would have fixed the naming and left
 * the revocation exactly as broken, so the tests that matter most here are
 * about killing a session, not about minting one.
 *
 * A fake Redis, deliberately: the questions are «what is stored» and «what
 * happens on revoke», and both are answerable against an in-memory map. A real
 * Redis would only add a way for this suite to fail for an unrelated reason.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  /** The reverse index is a Redis SET, so the fake models one. It used to be a
   * JSON string, and that shape is exactly what the read-modify-write race the
   * service now avoids was made of. */
  const sets = new Map<string, Set<string>>();

  const service = {
    setWithTtl: jest.fn(async (key: string, value: string, _ttlSeconds: number) => {
      store.set(key, value);
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    delete: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    getAndDelete: jest.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    addToSetWithTtl: jest.fn(async (key: string, member: string, _ttlSeconds: number) => {
      const existing = sets.get(key) ?? new Set<string>();
      existing.add(member);
      sets.set(key, existing);
    }),
    removeFromSet: jest.fn(async (key: string, member: string) => {
      sets.get(key)?.delete(member);
    }),
    deleteSetAndItsMembers: jest.fn(async (key: string, memberKeyPrefix: string) => {
      const members = [...(sets.get(key) ?? [])];
      sets.delete(key);
      for (const member of members) store.delete(`${memberKeyPrefix}${member}`);
      return members.length;
    }),
  };

  /** Everything Redis holds, as one string — keys, values and set members. The
   * dump assertions below must see the index too, or «the token is nowhere in
   * Redis» would be proved against half of Redis. */
  const dump = () =>
    [
      ...[...store.entries()].map(([k, v]) => `${k}|${v}`),
      ...[...sets.entries()].map(([k, v]) => `${k}|${[...v].join(',')}`),
    ].join('\n');

  return { store, sets, dump, service: service as unknown as RedisService, spies: service };
}

const OPERATOR = { operatorId: 'op-1', email: 'safety@abny.app', role: 'SAFETY' as const };

describe('operator sessions', () => {
  it('returns a high-entropy token and NEVER stores it', async () => {
    const { dump, service } = fakeRedis();
    const sessions = new OperatorSessionService(service);

    const token = await sessions.open(OPERATOR);

    expect(token.length).toBeGreaterThanOrEqual(40);
    // The whole store, stringified, must not contain the token anywhere — not
    // as a key, not inside a value, not inside the reverse index. A dump of
    // Redis must not let anyone sign in.
    expect(dump()).not.toContain(token);
    // What IS stored is its hash.
    expect(dump()).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('resolves the token it minted, and nothing else', async () => {
    const { service } = fakeRedis();
    const sessions = new OperatorSessionService(service);

    const token = await sessions.open(OPERATOR);

    const resolved = await sessions.resolve(token);
    expect(resolved?.operatorId).toBe('op-1');
    expect(resolved?.role).toBe('SAFETY');
    expect(resolved?.issuedAt).toBeTruthy();

    // Every not-a-session shape answers the same way: null, never a throw, so
    // the guard turns all of them into one indistinguishable 401.
    expect(await sessions.resolve(undefined)).toBeNull();
    expect(await sessions.resolve('')).toBeNull();
    expect(await sessions.resolve('short')).toBeNull();
    expect(await sessions.resolve(`${token}x`)).toBeNull();
  });

  it('treats a corrupt stored value as no session rather than as a valid one', async () => {
    const { store, service } = fakeRedis();
    const sessions = new OperatorSessionService(service);
    const token = await sessions.open(OPERATOR);

    const key = [...store.keys()].find((k) => k.startsWith('operator-session:'))!;
    store.set(key, '{ not json');

    expect(await sessions.resolve(token)).toBeNull();
  });

  it('signs out one session without touching the others', async () => {
    const { service } = fakeRedis();
    const sessions = new OperatorSessionService(service);

    const laptop = await sessions.open(OPERATOR);
    const phone = await sessions.open(OPERATOR);

    await sessions.close(laptop, OPERATOR.operatorId);

    expect(await sessions.resolve(laptop)).toBeNull();
    expect(await sessions.resolve(phone)).not.toBeNull();
    // And the signed-out session left the reverse index too, so a later
    // `revokeAll` reports the sessions that actually exist. A count that
    // includes sessions already gone is a count nobody can act on.
    expect(await sessions.revokeAll(OPERATOR.operatorId)).toBe(1);
  });

  it('keeps every concurrent sign-in in the index — none is lost to a race', async () => {
    const { service } = fakeRedis();
    const sessions = new OperatorSessionService(service);

    // Ten sign-ins that overlap. Under the old JSON-array index these
    // interleaved read-modify-writes dropped hashes, and a dropped hash is a
    // LIVE SESSION `revokeAll` CANNOT SEE — a revocation that reports success
    // and leaves the person signed in.
    const tokens = await Promise.all(Array.from({ length: 10 }, () => sessions.open(OPERATOR)));

    expect(await sessions.revokeAll(OPERATOR.operatorId)).toBe(10);
    for (const token of tokens) {
      expect(await sessions.resolve(token)).toBeNull();
    }
  });

  it('THE POINT — revoking kills every session this person holds, immediately', async () => {
    const { service } = fakeRedis();
    const sessions = new OperatorSessionService(service);

    const laptop = await sessions.open(OPERATOR);
    const phone = await sessions.open(OPERATOR);
    const other = await sessions.open({ operatorId: 'op-2', email: 'b@abny.app', role: 'SUPPORT' });

    const killed = await sessions.revokeAll('op-1');

    expect(killed).toBe(2);
    expect(await sessions.resolve(laptop)).toBeNull();
    expect(await sessions.resolve(phone)).toBeNull();
    // And nobody else was logged out. A revocation that took the team with it
    // would be the same defect wearing new code.
    expect(await sessions.resolve(other)).not.toBeNull();
  });

  it('revoking somebody with no sessions is zero, not an error', async () => {
    const { service } = fakeRedis();
    const sessions = new OperatorSessionService(service);
    await expect(sessions.revokeAll('nobody')).resolves.toBe(0);
  });

  it('bounds a session to one working day, and never renews it', async () => {
    const { service, spies } = fakeRedis();
    const sessions = new OperatorSessionService(service);

    expect(OPERATOR_SESSION_TTL_SECONDS).toBe(8 * 60 * 60);

    const token = await sessions.open(OPERATOR);
    for (const call of spies.setWithTtl.mock.calls) {
      expect(call[2]).toBe(OPERATOR_SESSION_TTL_SECONDS);
    }

    spies.setWithTtl.mockClear();
    await sessions.resolve(token);
    // Resolving must not extend anything. A session that renews itself on
    // activity never expires for the person who is always active — who is
    // precisely the person whose session is most worth bounding.
    expect(spies.setWithTtl).not.toHaveBeenCalled();
  });
});
