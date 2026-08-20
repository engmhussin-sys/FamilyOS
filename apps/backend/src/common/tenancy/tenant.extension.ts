import { Prisma } from '@prisma/client';

import { currentContext } from './tenant-context';
import { CrossTenantWriteError, TenantContextMissingError } from './tenant.errors';
import {
  GLOBAL_MODELS,
  PLATFORM_ANNOTATED_MODELS,
  SELF_TENANT_MODELS,
  SHARED_NULL_TENANT_MODELS,
  STRICT_TENANT_MODELS,
} from './tenant-model-registry';

/**
 * Layer 1 of three (docs/05-Database-Architecture §6). Turns tenant isolation
 * from something 154 call sites remember to do into something the client does
 * whether they remember or not.
 *
 * Design notes that matter:
 *
 * - DENY BY DEFAULT. A tenant-scoped model touched with neither a TenantContext
 *   nor a SystemContext throws `TenantContextMissingError`. It does not fall
 *   back to "return everything", which is what an unguarded Prisma call does
 *   today and is the whole reason this file exists.
 *
 * - `findUnique` IS filtered. Prisma 5's `extendedWhereUnique` (GA since 5.0)
 *   accepts non-unique filters alongside the unique one, so we inject
 *   `familyId` directly instead of rewriting the call to `findFirst`. That
 *   matters inside `$transaction`: rewriting the operation would require
 *   reaching for the root client and would silently drop the call out of the
 *   caller's transaction. Injecting keeps the query on the transaction client
 *   it was issued on. Verified against a real PostgreSQL — a cross-tenant
 *   `findUnique` returns `null` and `findUniqueOrThrow`/`update`/`delete`
 *   raise P2025, i.e. the API layer answers 404, not 403.
 *
 * - KNOWN LIMIT, stated rather than hidden: a Prisma Client Extension sees
 *   only TOP-LEVEL operations. Nested reads (`include`/`select`) and nested
 *   writes inside `data` are part of the same engine query and are not
 *   intercepted. They are safe by construction rather than by injection:
 *   the parent row is already tenant-filtered, and every relation is a
 *   foreign key to a row in the same family. Nested CREATE of a strict model
 *   fails closed on `family_id NOT NULL`. `$queryRaw` is likewise not
 *   intercepted — that is what Postgres RLS (layer 3) and the CI static guard
 *   are for.
 */

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WHERE_WRITE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);
const DATA_WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
]);

type AnyArgs = Record<string, unknown> & { where?: Record<string, unknown> };

function stampTenant(
  data: unknown,
  column: string,
  familyId: string,
  model: string,
  operation: string,
): void {
  if (data === null || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const row of data) stampTenant(row, column, familyId, model, operation);
    return;
  }
  const row = data as Record<string, unknown>;
  const existing = row[column];
  if (existing !== undefined && existing !== null && existing !== familyId) {
    // The payload tried to plant a row in another family. This is the
    // IDOR/BOLA write case (A4 §3, CWE-639) and it is refused outright rather
    // than silently overwritten, so the attempt is visible in the logs.
    throw new CrossTenantWriteError(model, operation, String(existing), familyId);
  }
  row[column] = familyId;
}

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: 'abny-tenant-guard',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          const modelName = String(model);

          // Class (c)/(d): genuinely not family-tenanted. Pass straight through.
          if (GLOBAL_MODELS.has(modelName)) return query(args);

          const ctx = currentContext();

          // The audited escape hatch. `runAsSystem` has already logged the
          // reason and the justification by the time we get here.
          if (ctx?.kind === 'SYSTEM') return query(args);

          // DENY BY DEFAULT — the entire point of this sprint.
          if (ctx?.kind !== 'TENANT') {
            throw new TenantContextMissingError(modelName, String(operation));
          }

          const familyId = ctx.familyId;
          const column = SELF_TENANT_MODELS.get(modelName) ?? 'familyId';
          const sharedNull = SHARED_NULL_TENANT_MODELS.has(modelName);
          const a = (args ?? {}) as AnyArgs;

          if (READ_OPS.has(String(operation)) || WHERE_WRITE_OPS.has(String(operation))) {
            const where = { ...(a.where ?? {}) } as Record<string, unknown>;
            if (sharedNull && READ_OPS.has(String(operation))) {
              // "mine OR the platform's" — never "everyone's".
              const existingAnd = where.AND;
              where.AND = [
                ...(Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : []),
                { OR: [{ [column]: familyId }, { [column]: null }] },
              ];
            } else {
              where[column] = familyId;
            }
            a.where = where;
          }

          // A SELF_TENANT model is scoped by its own primary key. Stamping
          // `id` on a create would make it impossible to register a new family,
          // so writes to it are filtered (above) but never stamped.
          if (DATA_WRITE_OPS.has(String(operation)) && !SELF_TENANT_MODELS.has(modelName)) {
            if (operation === 'upsert') {
              if (a.create) stampTenant(a.create, column, familyId, modelName, 'upsert.create');
              if (a.update) stampTenant(a.update, column, familyId, modelName, 'upsert.update');
            } else if (a.data !== undefined) {
              stampTenant(a.data, column, familyId, modelName, String(operation));
            }
          }

          return query(a);
        },
      },
    },
  });
}

/** Exported for the guard tests, so the classification is testable directly. */
export const TENANT_EXTENSION_MODEL_CLASSES = {
  STRICT_TENANT_MODELS,
  SHARED_NULL_TENANT_MODELS,
  PLATFORM_ANNOTATED_MODELS,
  SELF_TENANT_MODELS,
  GLOBAL_MODELS,
};
