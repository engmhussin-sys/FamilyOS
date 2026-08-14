import type { Prisma, PrismaClient } from '@prisma/client';

/** The Postgres session variable the RLS policies in 0004 key on. */
export const RLS_TENANT_SETTING = 'app.current_family_id';

/**
 * Runs `fn` inside one database transaction with the RLS tenant variable set
 * TRANSACTION-LOCALLY.
 *
 * `set_config(name, value, is_local => true)` — the third argument is the whole
 * point. A session-level `SET` would survive the request and leak the tenant
 * onto whichever request borrows that pooled connection next; A2 flagged this
 * and `test/database/tenant-rls.integration.spec.ts` demonstrates both halves
 * (it holds for the life of the transaction, and it is gone afterwards on the
 * same physical connection).
 *
 * Cost, stated honestly: this pins one pooled connection for the duration of
 * the callback. It is the correct tool for a write path or a job that must be
 * provably tenant-confined; it is NOT a free wrapper to put around every read.
 */
export async function withRls<T>(
  prisma: PrismaClient,
  familyId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('${RLS_TENANT_SETTING}', $1, true)`,
        familyId,
      );
      return fn(tx);
    },
    { timeout: options?.timeoutMs ?? 8000 },
  );
}
