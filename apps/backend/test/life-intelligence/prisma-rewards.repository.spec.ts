/**
 * DA-002 unit coverage for the rewrite of PrismaRewardsRepository's two
 * critical write paths. The behaviour against a real database is proven in
 * test/database/rewards-concurrency.integration.spec.ts; this suite pins
 * the ORDER of operations, which is where the correctness actually lives:
 *
 *   - the ledger insert happens FIRST and the balance is touched ONLY if
 *     that insert created a row (otherwise a duplicate still moves coins);
 *   - a redemption is claimed by a conditional UPDATE before any money
 *     moves, and an insufficient balance aborts the whole transaction.
 */
import { BadRequestException } from '@nestjs/common';

import { runWithTenant } from '../../src/common/tenancy/tenant-context';

import { PrismaRewardsRepository } from '../../src/modules/life-intelligence/infrastructure/repositories/prisma-rewards.repository';
import {
  SQL_APPLY_ACCOUNT_DELTAS,
  SQL_CLAIM_REDEMPTION,
  SQL_DEDUCT_COINS_IF_SUFFICIENT,
  SQL_INSERT_EARN_LEDGER_ENTRY,
  SQL_INSERT_REDEEM_LEDGER_ENTRY,
} from '../../src/modules/life-intelligence/infrastructure/repositories/rewards.sql';

const FAMILY_ID = 'family-1';
/** F2: the raw statements now carry family_id, taken from the ambient tenant.
 * Every call below therefore runs inside a tenant context — which is also the
 * point: outside one, `tenantIdForWrite()` throws rather than writing a row
 * with nobody's tenant on it. */
const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenant({ familyId: FAMILY_ID, actorType: 'USER', actorId: 'user-1' }, async () => fn());

describe('PrismaRewardsRepository (DA-002)', () => {
  let executeRawUnsafe: jest.Mock;
  let repository: PrismaRewardsRepository;

  /** Runs the callback with a tx object exposing the mocked raw executor,
   * mirroring Prisma's interactive-transaction contract. */
  const prismaMock = {
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    executeRawUnsafe = jest.fn();
    prismaMock.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ $executeRawUnsafe: executeRawUnsafe }),
    );
    repository = new PrismaRewardsRepository(prismaMock as never);
  });

  describe('applyEarn', () => {
    it('writes the ledger first and only then the balance', async () => {
      executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

      const granted = await asTenant(() => repository.applyEarn('child-1', 'XP', 50, undefined, 'habit_streak', 'key-1'));

      expect(granted).toBe(true);
      expect(executeRawUnsafe).toHaveBeenNthCalledWith(
        1,
        SQL_INSERT_EARN_LEDGER_ENTRY,
        'child-1',
        'XP',
        50,
        50,
        'habit_streak',
        'key-1',
        FAMILY_ID,
        // B4: `$8` is `business_date`. NULL here because this caller passed no
        // business date — an uncapped, pre-B4-shaped grant. The column is
        // nullable precisely so those keep working unchanged.
        null,
      );
      expect(executeRawUnsafe).toHaveBeenNthCalledWith(
        2,
        SQL_APPLY_ACCOUNT_DELTAS,
        'child-1',
        50,
        0,
        0,
        null,
        FAMILY_ID,
      );
    });

    it('leaves the balance untouched when the database rejects the duplicate', async () => {
      executeRawUnsafe.mockResolvedValueOnce(0); // ON CONFLICT DO NOTHING

      const granted = await asTenant(() => repository.applyEarn('child-1', 'XP', 50, undefined, 'habit_streak', 'key-1'));

      expect(granted).toBe(false);
      expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    it('synthesises a key when the caller has none, so the unique index still applies', async () => {
      executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

      await asTenant(() => repository.applyEarn('child-1', 'COINS', 20, undefined, 'manual:user-1'));

      const key = executeRawUnsafe.mock.calls[0][6];
      expect(typeof key).toBe('string');
      expect(key).toMatch(/^nokey:/);
    });

    it('B4: stamps the FAMILY business date onto the ledger row when the caller supplies one', async () => {
      executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

      await asTenant(() =>
        repository.applyEarn('child-1', 'XP', 10, undefined, 'reward_rule:r1', 'key-bd', undefined, '2026-08-14'),
      );

      // `$8` — the same day the idempotency key was composed from, so the cap
      // count and the key can never disagree about which day a grant belongs to.
      expect(executeRawUnsafe.mock.calls[0][8]).toBe('2026-08-14');
    });

    it('moves stars by one for a BADGE grant and passes the new level through', async () => {
      executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

      await asTenant(() => repository.applyEarn('child-1', 'BADGE', 1, 4, 'badge:first_streak', 'key-b'));

      expect(executeRawUnsafe).toHaveBeenNthCalledWith(
        2,
        SQL_APPLY_ACCOUNT_DELTAS,
        'child-1',
        0,
        0,
        1,
        4,
        FAMILY_ID,
      );
    });
  });

  describe('approveRedemption', () => {
    it('claims the redemption, deducts, then writes the REDEEM ledger row', async () => {
      executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1);

      await asTenant(() => repository.approveRedemption('red-1', 'child-1', 100, 'user-1'));

      expect(executeRawUnsafe).toHaveBeenNthCalledWith(1, SQL_CLAIM_REDEMPTION, 'red-1', 'user-1', FAMILY_ID);
      expect(executeRawUnsafe).toHaveBeenNthCalledWith(
        2,
        SQL_DEDUCT_COINS_IF_SUFFICIENT,
        'child-1',
        100,
        FAMILY_ID,
      );
      expect(executeRawUnsafe).toHaveBeenNthCalledWith(
        3,
        SQL_INSERT_REDEEM_LEDGER_ENTRY,
        'child-1',
        100,
        'red-1',
        FAMILY_ID,
      );
    });

    it('rejects a redemption already decided by a concurrent approver, before touching the balance', async () => {
      executeRawUnsafe.mockResolvedValueOnce(0);

      await expect(
        asTenant(() => repository.approveRedemption('red-1', 'child-1', 100, 'user-1')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    });

    it('aborts the whole transaction when the balance is insufficient', async () => {
      executeRawUnsafe.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      await expect(
        asTenant(() => repository.approveRedemption('red-1', 'child-1', 100, 'user-1')),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The REDEEM ledger row is never reached; the claim is rolled back
      // with the transaction.
      expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
    });
  });
});
