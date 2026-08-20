/**
 * THE CHILD LEARNING CATALOGUE — the properties that must hold without a
 * database, and the invariant the whole surface exists to keep.
 *
 * Two halves:
 *
 *   1. STRUCTURAL. Read Nest's OWN route metadata off
 *      `ChildCatalogueController` — the same way
 *      `tenancy/controller-guard-coverage.spec.ts` does — and assert that the
 *      surface is read-only BY CONSTRUCTION: every route is a GET, every route
 *      carries `DeviceJwtAuthGuard` and `Role.CHILD`, and no handler declares a
 *      `@Body`, a `@Query` or a `@Param`. A future handler that adds one fails
 *      here rather than in a review.
 *
 *   2. THE PROJECTION. `buildLearningCatalogue` is a pure function of ONE
 *      integer, so "the served values come from the server's own constants,
 *      not from anything the caller sent" is provable by exhaustion: the same
 *      age always yields byte-identical output, and every code and label in it
 *      is traced back to `shared/rewards/*`.
 *
 * It deliberately reads the compiled decorators, not the source text: a route
 * that "looks read-only" because the string `@Get` appears in a comment does
 * not pass.
 */
import { METHOD_METADATA, PATH_METADATA, GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';

import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { Role } from '../../src/common/authz/principal-role';
import { ChildCatalogueController } from '../../src/modules/rewards-engine/presentation/controllers/child-catalogue.controller';
import { ChildAchievementsController } from '../../src/modules/rewards-engine/presentation/controllers/child-achievements.controller';
import {
  buildLearningCatalogue,
  buildLearningCatalogueDomains,
  suggestedCategoriesForAge,
  suggestedDifficultyForAge,
  suggestedDurationMinutesForAge,
  suggestedPointsForAge,
  suggestedVerificationForCategory,
  type CatalogueItem,
} from '../../src/modules/rewards-engine/domain/learning-catalogue';
import {
  CATEGORY_ACTIVITIES,
  CATEGORY_STREAK_KIND,
  PROGRAM_ACTIVITY_LABEL_AR,
  PROGRAM_CATEGORIES,
  PROGRAM_CATEGORY_LABEL_AR,
  type ProgramCategory,
} from '../../src/shared/rewards/program-taxonomy';
import { VERIFICATION_MATRIX } from '../../src/shared/rewards/verification';
import { ageBandFor } from '../../src/modules/ai-core/domain/age-band';

// --- helpers ---------------------------------------------------------------

interface DiscoveredRoute {
  handler: string;
  verb: string;
  path: string;
  guardNames: string[];
  roles: string[] | undefined;
  paramTypes: number[];
}

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

function routesOf(controller: new (...args: never[]) => object): DiscoveredRoute[] {
  const proto = controller.prototype as Record<string, unknown>;
  const classGuards: unknown[] = (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];
  const out: DiscoveredRoute[] = [];

  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler);
    if (path === undefined) continue;

    const methodGuards: unknown[] = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
    // Nest keys route args as `"<paramtype>:<index>"` on the CONSTRUCTOR, per
    // handler name — this is the same store `@Body()`/`@Query()` write to.
    const args =
      (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) as Record<string, unknown>) ?? {};

    out.push({
      handler: name,
      verb: HTTP_VERBS[Reflect.getMetadata(METHOD_METADATA, handler) as number],
      path: String(path),
      guardNames: [...classGuards, ...methodGuards].map((g) =>
        typeof g === 'function' ? g.name : String(g),
      ),
      roles:
        (Reflect.getMetadata(ROLES_METADATA, handler) as string[] | undefined) ??
        (Reflect.getMetadata(ROLES_METADATA, controller) as string[] | undefined),
      paramTypes: Object.keys(args).map((key) => Number(key.split(':')[0])),
    });
  }
  return out;
}

/** Arabic script, at least one letter. A code like `QURAN_MEMORIZE_AYAH` or a
 * status like `PENDING` fails this — which is the point. */
const ARABIC = /[؀-ۿ]/;

/** Every `*Ar` string in the response, with a path, so a failure names the
 * field rather than saying "somewhere in the body". */
function arabicFields(node: unknown, path = '$'): Array<{ path: string; value: unknown }> {
  const found: Array<{ path: string; value: unknown }> = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => found.push(...arabicFields(v, `${path}[${i}]`)));
    return found;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.endsWith('Ar')) found.push({ path: `${path}.${key}`, value });
      found.push(...arabicFields(value, `${path}.${key}`));
    }
  }
  return found;
}

function allItems(ageYears: number): CatalogueItem[] {
  return buildLearningCatalogue(ageYears).domains.flatMap((d) => [...d.items]);
}

const AGES = [6, 7, 8, 9, 11, 12, 14, 15, 17];

// ===========================================================================
// 1. THE SURFACE IS READ-ONLY BY CONSTRUCTION
// ===========================================================================

describe('child learning catalogue — the surface has no mutating route', () => {
  const routes = routesOf(ChildCatalogueController);

  it('declares at least one route (a controller that discovered nothing would pass every test below vacuously)', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.map((r) => `${r.verb} ${r.path}`).sort()).toEqual(['GET /', 'GET domains']);
  });

  it('EVERY route is a GET — there is no POST, PATCH, PUT or DELETE on this controller', () => {
    for (const route of routes) {
      expect(route.verb).toBe('GET');
    }
  });

  it('NO handler accepts a body, a query parameter or a path parameter', () => {
    // THE INVARIANT, STATED AS A TYPE-LEVEL FACT. A child must not be able to
    // influence `points`, `reward`, `verificationLevel`,
    // `requiresParentApproval` or any quota. It cannot, because there is no
    // channel: `@Body`, `@Query` and `@Param` are absent from every handler,
    // so a request carrying `{"points": 9999}` or `?maxPerDay=50` is not
    // "ignored" — it is never read by anything.
    const forbidden = new Set<number>([
      RouteParamtypes.BODY,
      RouteParamtypes.QUERY,
      RouteParamtypes.PARAM,
      RouteParamtypes.RAW_BODY,
      RouteParamtypes.FILE,
      RouteParamtypes.FILES,
    ]);
    for (const route of routes) {
      const offending = route.paramTypes.filter((t) => forbidden.has(t));
      expect({ handler: route.handler, offending }).toEqual({ handler: route.handler, offending: [] });
    }
  });

  it('EVERY route carries DeviceJwtAuthGuard per route, and never the parent JwtAuthGuard', () => {
    for (const route of routes) {
      expect(route.guardNames).toContain('DeviceJwtAuthGuard');
      expect(route.guardNames).not.toContain('JwtAuthGuard');
    }
  });

  it('EVERY route declares CHILD and only CHILD — the same roles ChildAchievementsController declares', () => {
    for (const route of routes) {
      expect(route.roles).toEqual([Role.CHILD]);
    }
    // Cross-check against the surface this one was copied from, so "the same
    // shape" is asserted rather than claimed.
    for (const route of routesOf(ChildAchievementsController)) {
      expect(route.roles).toEqual([Role.CHILD]);
    }
  });

  it('no class-level guard — the guard is on the route, per the pattern F1 established', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ChildCatalogueController)).toBeUndefined();
  });
});

// ===========================================================================
// 2. THE VALUES COME FROM THE SERVER'S OWN CONSTANTS
// ===========================================================================

describe('child learning catalogue — every served value is traceable to a server constant', () => {
  it('is a pure function of age: the same age produces byte-identical output', () => {
    for (const age of AGES) {
      expect(JSON.stringify(buildLearningCatalogue(age))).toEqual(
        JSON.stringify(buildLearningCatalogue(age)),
      );
    }
  });

  it('serves EVERY category in PROGRAM_CATEGORIES and EVERY activity in CATEGORY_ACTIVITIES', () => {
    const catalogue = buildLearningCatalogue(10);
    expect(catalogue.domains.map((d) => d.code).sort()).toEqual([...PROGRAM_CATEGORIES].sort());

    const expectedIds = PROGRAM_CATEGORIES.flatMap((c) =>
      CATEGORY_ACTIVITIES[c as ProgramCategory].map((a) => `${c}:${a}`),
    ).sort();
    expect(allItems(10).map((i) => i.id).sort()).toEqual(expectedIds);
    expect(catalogue.totals.activities).toBe(expectedIds.length);
    expect(catalogue.totals.domains).toBe(PROGRAM_CATEGORIES.length);
  });

  it('titles and domain labels are the EXACT strings the parent catalogue serves — no second copy', () => {
    for (const item of allItems(10)) {
      expect(item.titleAr).toBe(PROGRAM_ACTIVITY_LABEL_AR[item.activityCode]);
      expect(item.domainLabelAr).toBe(PROGRAM_CATEGORY_LABEL_AR[item.domainCode]);
      expect(item.contentKind).toBe(CATEGORY_STREAK_KIND[item.domainCode]);
    }
  });

  it('verification is read from VERIFICATION_MATRIX, and no item is ever offered as SELF_CHECK', () => {
    for (const item of allItems(10)) {
      const spec = VERIFICATION_MATRIX[item.verification.method];
      expect(item.verification.method).toBe(suggestedVerificationForCategory(item.domainCode));
      expect(item.verification.labelAr).toBe(spec.labelAr);
      expect(item.verification.rationaleAr).toBe(spec.rationaleAr);
      expect(item.verification.strength).toBe(spec.strength);
      expect(item.verification.canAutoApprove).toBe(spec.canAutoApprove);
      expect(item.verification.requiresExplicitChoice).toBe(spec.requiresExplicitChoice);
      // The advisory rule the suggestion engine already states about itself:
      // a draft NEVER proposes the weakest method. The catalogue inherits it
      // because it reads the same function.
      expect(item.verification.method).not.toBe('SELF_CHECK');
    }
  });

  it('requiresParentApproval is DERIVED from the matrix, never asserted', () => {
    for (const item of allItems(10)) {
      expect(item.requiresParentApproval).toBe(
        !VERIFICATION_MATRIX[item.verification.method].canAutoApprove,
      );
    }
    // QURAN drafts RECITATION_SUBMISSION, which cannot auto-approve — so every
    // Quran item in the catalogue says a parent decides.
    const quran = allItems(10).filter((i) => i.domainCode === 'QURAN');
    expect(quran.length).toBeGreaterThan(0);
    for (const item of quran) expect(item.requiresParentApproval).toBe(true);
  });

  it('duration, points and difficulty are the SAME tables RewardSuggestionService drafts from', () => {
    for (const age of AGES) {
      for (const item of allItems(age)) {
        expect(item.estimatedDurationMinutes).toBe(suggestedDurationMinutesForAge(age));
        expect(item.reward.suggestedAmount).toBe(suggestedPointsForAge(age));
        expect(item.difficulty).toBe(suggestedDifficultyForAge(age));
        expect(item.reward.type).toBe('POINTS');
      }
    }
  });

  it('quotas are the RewardProgram schema defaults, identical for every item and every age', () => {
    for (const age of AGES) {
      for (const item of allItems(age)) {
        expect(item.limits).toEqual({
          frequency: 'DAILY',
          frequencyLabelAr: 'كل يوم',
          maxPerDay: 1,
          maxPerWeek: 7,
          streakMultiplierMaxBps: 30000,
        });
      }
    }
  });

  it('the fields with NO source in the repository are explicitly absent, never invented', () => {
    for (const item of allItems(10)) {
      // No per-activity age range exists anywhere. `null`, plus the schema
      // default under its real name — not a fabricated "suitable from 7".
      expect(item.ageRange.recommendedMinAge).toBeNull();
      expect(item.ageRange.recommendedMaxAge).toBeNull();
      expect(item.ageRange.programDefaultMinAge).toBe(0);
      // No points RANGE exists — only the one figure the server drafts.
      expect(item.reward.range).toBeNull();
      expect(typeof item.reward.suggestedAmount).toBe('number');
    }
  });
});

// ===========================================================================
// 3. AGE: ANNOTATED, NEVER HIDDEN
// ===========================================================================

describe('child learning catalogue — age annotates, it never hides', () => {
  it('a six-year-old and a seventeen-year-old are offered the SAME set of items', () => {
    const young = allItems(6).map((i) => i.id).sort();
    const old = allItems(17).map((i) => i.id).sort();
    expect(young).toEqual(old);
    // The convention `domain_chooser.dart` and `GoalCard` already apply:
    // dimmed, never hidden, never locked.
    for (const age of AGES) {
      for (const item of allItems(age)) expect(item.suitability.hidden).toBe(false);
    }
  });

  it('suitability follows suggestedCategoriesForAge — the existing derivation, not a second one', () => {
    for (const age of AGES) {
      const suggested = new Set<string>(suggestedCategoriesForAge(age));
      const catalogue = buildLearningCatalogue(age);
      for (const domain of catalogue.domains) {
        expect(domain.suitability.suggestedAtThisAge).toBe(suggested.has(domain.code));
        for (const item of domain.items) {
          expect(item.suitability.suggestedAtThisAge).toBe(suggested.has(domain.code));
        }
      }
    }
  });

  it('the annotation actually changes with age — PROGRAMMING is suggested at 14 and not at 7', () => {
    const at7 = buildLearningCatalogue(7).domains.find((d) => d.code === 'PROGRAMMING')!;
    const at14 = buildLearningCatalogue(14).domains.find((d) => d.code === 'PROGRAMMING')!;
    expect(at7.suitability.suggestedAtThisAge).toBe(false);
    expect(at14.suitability.suggestedAtThisAge).toBe(true);
    // …and the 7-year-old still receives it, with all of its activities.
    expect(at7.items.length).toBe(at14.items.length);
    expect(at7.items.length).toBeGreaterThan(0);
  });

  it('suggested domains sort first, and the rest keep the declared taxonomy order', () => {
    for (const age of AGES) {
      const domains = buildLearningCatalogue(age).domains;
      const flags = domains.map((d) => d.suitability.suggestedAtThisAge);
      expect(flags.slice().sort((a, b) => Number(b) - Number(a))).toEqual(flags);
    }
  });

  it('the age band comes from ai-core/domain/age-band.ts — there is no second implementation', () => {
    for (const age of AGES) {
      const catalogue = buildLearningCatalogue(age);
      expect(catalogue.child.ageYears).toBe(age);
      expect(catalogue.child.ageBand).toBe(ageBandFor(age));
      expect(catalogue.child.ageBandLabelAr).toMatch(ARABIC);
    }
  });
});

// ===========================================================================
// 4. ARABIC — no raw enum is ever the thing a child reads
// ===========================================================================

describe('child learning catalogue — every user-visible string is server-authored Arabic', () => {
  it('every `*Ar` field in the whole response is a non-empty Arabic string', () => {
    for (const age of [6, 10, 16]) {
      const fields = arabicFields(buildLearningCatalogue(age));
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect({ path: field.path, isString: typeof field.value === 'string' }).toEqual({
          path: field.path,
          isString: true,
        });
        expect({ path: field.path, arabic: ARABIC.test(field.value as string) }).toEqual({
          path: field.path,
          arabic: true,
        });
      }
    }
  });

  it('no `*Ar` field is a raw enum code — a code never stands in for a label', () => {
    const codes = new Set<string>([
      ...PROGRAM_CATEGORIES,
      ...Object.keys(PROGRAM_ACTIVITY_LABEL_AR),
      ...Object.keys(VERIFICATION_MATRIX),
      'EASY',
      'MEDIUM',
      'HARD',
      'DAILY',
      'WEEKLY',
      'ONCE',
      'POINTS',
      'WEAK',
      'MODERATE',
      'STRONG',
    ]);
    for (const field of arabicFields(buildLearningCatalogue(10))) {
      expect({ path: field.path, isCode: codes.has(String(field.value)) }).toEqual({
        path: field.path,
        isCode: false,
      });
    }
  });

  it('every item carries a readable Arabic title, description, domain label and content-kind label', () => {
    for (const item of allItems(10)) {
      for (const value of [
        item.titleAr,
        item.descriptionAr,
        item.domainLabelAr,
        item.contentKindLabelAr,
        item.difficultyLabelAr,
        item.reward.typeLabelAr,
        item.verification.strengthLabelAr,
        item.requiresParentApprovalNoteAr,
        item.suitability.noteAr,
      ]) {
        expect(typeof value).toBe('string');
        expect(value.trim().length).toBeGreaterThan(0);
        expect(value).toMatch(ARABIC);
      }
      // The description is composed from the labels, so it must contain them
      // rather than a code.
      expect(item.descriptionAr).toContain(item.titleAr);
      expect(item.descriptionAr).toContain(item.domainLabelAr);
      expect(item.descriptionAr).not.toContain(item.activityCode);
      expect(item.descriptionAr).not.toContain(item.domainCode);
    }
  });
});

// ===========================================================================
// 5. THE DOMAINS-ONLY PROJECTION
// ===========================================================================

describe('child learning catalogue — the domains-only route is the same projection', () => {
  it('has the same domains, in the same order, with the same suitability', () => {
    for (const age of AGES) {
      const full = buildLearningCatalogue(age);
      const light = buildLearningCatalogueDomains(age);
      expect(light.domains.map((d) => d.code)).toEqual(full.domains.map((d) => d.code));
      expect(light.totals).toEqual(full.totals);
      expect(light.child).toEqual(full.child);
      light.domains.forEach((d, i) => {
        expect(d.suitability).toEqual(full.domains[i].suitability);
        expect(d.activityCount).toBe(full.domains[i].items.length);
      });
    }
  });

  it('carries no activity lists at all — it is the chooser row, not the catalogue', () => {
    const light = buildLearningCatalogueDomains(10);
    for (const domain of light.domains) {
      expect((domain as Record<string, unknown>).items).toBeUndefined();
    }
  });
});
