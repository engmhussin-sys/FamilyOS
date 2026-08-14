#!/usr/bin/env ts-node
/**
 * CI guard — static half. Run with:  npx ts-node scripts/ci/assert-tenant-scoping.ts
 *
 * The Prisma Client Extension makes tenant isolation automatic for anything
 * that goes THROUGH it. This script exists for the three ways code can go
 * around it:
 *
 *   RULE 1  A second, un-extended PrismaClient.  `new PrismaClient()` anywhere
 *           but PrismaService is a client with no tenant guard on it.
 *   RULE 2  Raw SQL.  `$queryRaw` / `$executeRaw` are not intercepted by any
 *           extension. If the statement touches a strictly tenant-scoped table
 *           it must mention `family_id` itself.
 *   RULE 3  A client-supplied tenant.  CONTEXT.md principle 3: `familyId` is
 *           NEVER read from the client. So: no `familyId` field on any request
 *           DTO, no `@Body('familyId')`, no `@Query('familyId')`, and no
 *           `request.body/params/query` reads outside the presentation layer.
 *
 * Plus RULE 4, the schema-level invariant the extension depends on: every model
 * classified as strictly tenant-scoped really does carry a non-nullable
 * `familyId` in schema.prisma, and every model in schema.prisma is classified.
 *
 * Exit code 1 on any violation, with file:line for each.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  ALL_CLASSIFIED_MODELS,
  GLOBAL_MODELS,
  PLATFORM_ANNOTATED_MODELS,
  SELF_TENANT_MODELS,
  SHARED_NULL_TENANT_MODELS,
  STRICT_TENANT_MODELS,
} from '../../src/common/tenancy/tenant-model-registry';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const SCHEMA = path.join(ROOT, 'prisma/schema.prisma');

interface Violation {
  rule: string;
  file: string;
  line: number;
  detail: string;
}

const violations: Violation[] = [];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const files = walk(SRC);
const rel = (f: string) => path.relative(ROOT, f);

// ---------------------------------------------------------------------------
// RULE 1 — exactly one PrismaClient, and it is the extended one.
// ---------------------------------------------------------------------------
const PRISMA_CLIENT_ALLOWED = new Set(['src/common/prisma/prisma.service.ts']);
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/new\s+PrismaClient\s*\(/.test(line) && !PRISMA_CLIENT_ALLOWED.has(rel(file))) {
      violations.push({
        rule: 'RULE 1 (un-extended Prisma client)',
        file: rel(file),
        line: i + 1,
        detail:
          'Instantiating PrismaClient directly bypasses the tenant guard extension. Inject PrismaService instead.',
      });
    }
  });
}

// ---------------------------------------------------------------------------
// RULE 2 — raw SQL against a tenant table must scope itself.
// ---------------------------------------------------------------------------
// Table names for the strictly tenant-scoped models, derived from schema.prisma
// so the list cannot drift from the schema.
const schemaText = fs.readFileSync(SCHEMA, 'utf8');
const tableFor = new Map<string, string>();
for (const m of ALL_CLASSIFIED_MODELS) {
  const block = schemaText.match(new RegExp(`^model ${m} \\{([\\s\\S]*?)^\\}`, 'm'));
  const map = block?.[1].match(/@@map\("([^"]+)"\)/);
  if (map) tableFor.set(m, map[1]);
}
const strictTables = [...STRICT_TENANT_MODELS].map((m) => tableFor.get(m)).filter(Boolean) as string[];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/\$(queryRaw|executeRaw)/.test(text)) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!/\$(queryRaw|executeRaw)/.test(line)) return;
    // Look at the statement and a small window after it — template literals wrap.
    const window = lines.slice(i, i + 25).join('\n');
    const touched = strictTables.filter((t) => new RegExp(`\\b${t}\\b`).test(window));
    if (touched.length > 0 && !/family_id/.test(window)) {
      violations.push({
        rule: 'RULE 2 (raw SQL not tenant-scoped)',
        file: rel(file),
        line: i + 1,
        detail: `Raw SQL touches tenant table(s) [${touched.join(', ')}] without mentioning family_id. Extensions do not intercept $queryRaw — scope it explicitly or run it under runAsSystem() with a stated reason.`,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// RULE 3 — the tenant is never client-supplied.
// ---------------------------------------------------------------------------
/**
 * The one sanctioned place a familyId appears in a request path, with its
 * reason. It is compared against the verified token and answers 404 on a
 * mismatch (see LifeIntelligenceController.getFamilyStore).
 */
const CLIENT_FAMILY_ID_ALLOWED = new Map<string, string>([
  [
    'src/modules/life-intelligence/presentation/controllers/life-intelligence.controller.ts',
    'GET /life-intelligence/rewards/store/:familyId — legacy path shape. The param is compared to the verified token and answers 404 on mismatch; it is never used as a query key.',
  ],
]);

for (const file of files) {
  const r = rel(file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const at = { rule: '', file: r, line: i + 1, detail: '' };

    if (/@(Body|Query)\(\s*['"]familyId['"]/.test(line)) {
      violations.push({
        ...at,
        rule: 'RULE 3 (client-supplied tenant)',
        detail: 'familyId must come from the verified token, never from the body or the query string.',
      });
    }

    if (/@Param\(\s*['"]familyId['"]/.test(line) && !CLIENT_FAMILY_ID_ALLOWED.has(r)) {
      violations.push({
        ...at,
        rule: 'RULE 3 (client-supplied tenant)',
        detail:
          'A familyId path param is only acceptable when it is compared against the token and answers 404 on mismatch. Add the file to CLIENT_FAMILY_ID_ALLOWED with that reasoning if so.',
      });
    }

    if (r.endsWith('.dto.ts') && /^\s*familyId\??\s*:/.test(line)) {
      violations.push({
        ...at,
        rule: 'RULE 3 (client-supplied tenant)',
        detail: 'A request DTO must not carry familyId — CONTEXT.md principle 3.',
      });
    }

    // Reading the raw request outside the presentation layer is how a tenant
    // sneaks in through the back door.
    if (
      /\b(req|request)\.(body|params|query)\b/.test(line) &&
      !r.includes('/presentation/') &&
      !r.includes('/common/') &&
      !line.trim().startsWith('*') &&
      !line.trim().startsWith('//')
    ) {
      violations.push({
        ...at,
        rule: 'RULE 3 (raw request read outside presentation)',
        detail: 'Services and repositories must receive values as arguments, not read the HTTP request.',
      });
    }
  });
}

// ---------------------------------------------------------------------------
// RULE 4 — the classification is total and matches the schema.
// ---------------------------------------------------------------------------
const schemaModels = [...schemaText.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
for (const m of schemaModels) {
  if (!ALL_CLASSIFIED_MODELS.has(m)) {
    violations.push({
      rule: 'RULE 4 (unclassified model)',
      file: 'prisma/schema.prisma',
      line: 0,
      detail: `Model ${m} is in no tenancy class. Add it to src/common/tenancy/tenant-model-registry.ts — and if it belongs to a family, give it a familyId first.`,
    });
  }
}
for (const m of STRICT_TENANT_MODELS) {
  const block = schemaText.match(new RegExp(`^model ${m} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] ?? '';
  if (!/^\s*familyId\s+String\s/m.test(block)) {
    violations.push({
      rule: 'RULE 4 (strict model without a tenant key)',
      file: 'prisma/schema.prisma',
      line: 0,
      detail: `Model ${m} is classified strictly tenant-scoped but has no non-nullable familyId.`,
    });
  }
}

// ---------------------------------------------------------------------------
const total =
  STRICT_TENANT_MODELS.size +
  SHARED_NULL_TENANT_MODELS.size +
  PLATFORM_ANNOTATED_MODELS.size +
  SELF_TENANT_MODELS.size +
  GLOBAL_MODELS.size;

/* eslint-disable no-console */
console.log('tenant-scoping guard');
console.log(`  files scanned            : ${files.length}`);
console.log(`  models in schema.prisma  : ${schemaModels.length}`);
console.log(`  models classified        : ${total}`);
console.log(`    strict (family_id NOT NULL) : ${STRICT_TENANT_MODELS.size}`);
console.log(`    shared-null                 : ${SHARED_NULL_TENANT_MODELS.size}`);
console.log(`    platform-annotated          : ${PLATFORM_ANNOTATED_MODELS.size}`);
console.log(`    self-tenant                 : ${SELF_TENANT_MODELS.size}`);
console.log(`    global                      : ${GLOBAL_MODELS.size}`);
console.log(`  violations               : ${violations.length}`);

if (violations.length > 0) {
  console.error('');
  for (const v of violations) {
    console.error(`  ✗ ${v.rule}\n      ${v.file}:${v.line}\n      ${v.detail}`);
  }
  console.error('');
  process.exit(1);
}
console.log('  OK — no tenant-scoping violations.');
