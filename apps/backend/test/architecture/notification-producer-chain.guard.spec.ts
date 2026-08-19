/**
 * ============================================================================
 * ARCHITECTURE GUARD — NO PRODUCERLESS PRODUCTION NOTIFICATION.
 * ============================================================================
 *
 * THE DEFECT THIS FILE EXISTS FOR HAS SHIPPED THREE TIMES IN THIS REPOSITORY.
 *
 *   `PF-E-001`  The whole Smart Notification Engine: built, 168 tests green,
 *               and no production call site. Coverage measured the code that
 *               existed, never whether anything reached it.
 *   `PF-E-006`  The child half of `REWARD_GRANTED`: a catalogue entry, a
 *               composer, a writer, an approval gate — and no producer that
 *               targeted `CHILD`, so `child_messages` stayed at zero rows after
 *               a real grant.
 *   `GOAL_STALLED_PARENT`  Copy in two languages, a quiet-hours class, three
 *               scoring rows and a deep-link destination. Nothing produced it
 *               until `StalledGoalService` was written, one sprint later.
 *
 * Each was invisible for the same reason: every test asked whether a PIECE
 * worked, and none asked whether the PIECES WERE JOINED. This file asks the
 * second question, over the chain the product actually needs:
 *
 *     producer -> engine -> decision -> persistence -> deepLink
 *              -> delivery -> client routing
 *
 * ---------------------------------------------------------------------------
 * WHY IT CANNOT GO STALE, WHICH IS THE ONLY PROPERTY THAT MATTERS.
 *
 * Earlier guards in this repository rotted because they compared production
 * against a list somebody had to remember to edit. THERE IS NO SUCH LIST HERE.
 * Every expectation is READ, at test time, out of a PRODUCTION ARTEFACT:
 *
 *   `COPY_CATALOGUE`               the sentences the product intends to send
 *                                  (`notification-copy.ts` — `copyKeys()`).
 *   `COPY_RULES`                   the contextual copy keys the DECISION layer
 *                                  can select. Parsed out of whichever class
 *                                  `NOTIFICATION_DECISION_PROVIDER` is bound to
 *                                  in `life-intelligence.module.ts` — so
 *                                  swapping the provider re-points this guard.
 *   real call sites                every `.handleEvent({...})`,
 *                                  `.createForFamilyOwner({...})` and
 *                                  `.deliverNow(...)` under `src/`, with the
 *                                  event type RESOLVED from the argument.
 *   `NotificationEventInput`       the FACT SLOTS a producer may supply, which
 *                                  is what decides whether a contextual copy
 *                                  rule can ever fire.
 *   `NOTIFICATION_CLASSES`         quiet-hours class, audience, category.
 *   `URGENCY_BY_TYPE` /
 *   `ACHIEVEMENT_BASELINE_BY_TYPE` the scoring table.
 *   `DESTINATION_RULES`            the deep-link map (`destinationKeys()`).
 *   `deep_link.dart` x2            the CLIENT half of `abny://`, in both
 *   `*_deep_link_router.dart`      Flutter apps — read as text, never edited.
 *
 * Add a copy key and no producer: RULE P1 goes red naming the key. Add a
 * producer whose type has no scoring row: RULE P2 goes red naming the key. Add
 * a destination the child app cannot service: RULE P4 goes red naming the
 * surface. Nobody has to remember anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD CAN AND CANNOT DECIDE — read before trusting it.
 *
 * It CANNOT prove a call site is reached at runtime; that is the same
 * inter-procedural reachability property `notification-engine-bypass.guard.spec.ts`
 * and `scripts/ci/assert-event-emission.ts` both decline to approximate. What
 * it decides is narrower and total:
 *
 *   «is there a call site in `src/` that names this event type, and does the
 *    chain behind that name exist end to end?»
 *
 * And it decides it CONSERVATIVELY: an event type it cannot RESOLVE is not
 * quietly dropped. Every unresolved door is a RULE P5 failure unless a reviewer
 * classified it here with a reason. A guard that shrugs at what it cannot read
 * is a guard that reports whatever it happens to understand.
 *
 * ---------------------------------------------------------------------------
 * THE RULES.
 *
 *   P1  Every key in `COPY_CATALOGUE` is PRODUCIBLE, or carries an explicit
 *       classification with a per-entry reason, or is on the DEFECT LEDGER.
 *       The three sets must EXACTLY partition the catalogue — a key that gains
 *       a producer fails until its ledger entry is deleted, which is what makes
 *       this a ratchet rather than a scoreboard.
 *   P2  Every producible EVENT TYPE has the decision chain: a class row, an
 *       urgency row, an achievement-baseline row, and a catalogue sentence.
 *   P3  Every producible COPY KEY has the delivery chain: an explicit
 *       destination, a routable `abny://` link, a persistence branch for its
 *       audience, and a client route in that audience's app.
 *   P4  The three deep-link vocabularies — server, parent app, child app —
 *       are one for one. A surface the server can emit that a client cannot
 *       parse is a tap that dies on the device.
 *   P5  Every door site RESOLVES, or is classified with a reason.
 *   P6  NOT VACUOUS. The scan finds the producers this product demonstrably
 *       has, in the files that own them, by name.
 *   P7  NEGATIVE CONTROL, PERMANENT. The analyser is fed synthetic sources and
 *       must flag a producerless key, must clear it when a producer appears,
 *       and must reject an unreasoned classification. This is the check that
 *       proves P1 is capable of failing after somebody refactors the regexes.
 *
 * ---------------------------------------------------------------------------
 * COMMENTS ARE STRIPPED, STRINGS ARE NOT, AND THE SCANNER IS A REAL SCANNER.
 * Half this codebase's docstrings name the event types they explain; a guard
 * that counted prose would report producers that do not exist. String bodies
 * are KEPT, because `eventType: 'REWARD_GRANTED'` is the very thing being read.
 * `stripComments` is an ordered lexical scan rather than a chain of regexes,
 * because a regex chain gets `// DIRECT \`/self/*\` path` wrong — the `/*`
 * inside a line comment opens a block comment that swallows the next forty
 * lines of real code, including `this.notifyGrant(..., 'REWARD_GRANTED', ...)`
 * in `rewards-engine.service.ts`. That was measured here, not imagined.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  COPY_CATALOGUE,
  GENERIC_COPY_KEY,
  copyKeys,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import {
  DEEP_LINK_SURFACES,
  destinationKeys,
  hasExplicitDestination,
  isValidDeepLink,
  resolveNotificationDestination,
} from '../../src/modules/notifications/domain/engine/notification-destination';
import {
  ACHIEVEMENT_BASELINE_BY_TYPE,
  URGENCY_BY_TYPE,
} from '../../src/modules/notifications/domain/engine/notification-scoring';
import { NOTIFICATION_CLASSES } from '../../src/shared/notifications/notification-class';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND_ROOT, 'src');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '../..');
const PARENT_APP = path.join(REPO_ROOT, 'apps/parent-app/lib/core/routing');
const CHILD_APP = path.join(REPO_ROOT, 'apps/child-app/lib/core/routing');

/** The engine's own module. Its `notifyEvent` call is the engine delivering its
 * own decision, not a producer stating a new event. */
const ENGINE_DIR = 'src/modules/notification-engine/';

// ===========================================================================
// 0. THE LEXER
// ===========================================================================

export interface SourceFile {
  /** Repo-relative from `apps/backend`, POSIX separators. */
  readonly file: string;
  readonly content: string;
}

/**
 * Removes `//` and block comments and NOTHING ELSE, preserving every newline so
 * reported line numbers stay true. Ordered: a `/*` inside a line comment or a
 * string is not a block comment, and a `//` inside a string is not a comment.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n && source[i] === quote) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    if (c === '`') {
      out += c;
      i += 1;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
      }
      if (i < n) {
        out += source[i];
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The text between the parentheses of the call whose `(` is at `open`. */
function balanced(code: string, open: number): { text: string; end: number } {
  let depth = 0;
  let i = open;
  for (; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { text: code.slice(open + 1, i), end: i };
}

/**
 * Splits a VALUE list — call arguments, array elements — on its top-level
 * commas. Brackets only: an angle bracket in a value position is a comparison
 * (`c.goal.totalUnits > 0`) or an arrow (`=>`), and counting either as nesting
 * un-nests the `when:` predicate of every copy rule.
 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Splits a PARAMETER list, where angle brackets DO nest:
 * `variables: Readonly<Record<string, string | number>> = {}` is ONE parameter
 * — it is `notifyGrant`'s last — and splitting it into three shifts every
 * positional index the one-hop resolver depends on. A `<` only opens a generic
 * when it follows an identifier, so `a < b` and `a <= b` stay comparisons.
 */
function splitParameters(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let angle = 0;
  let current = '';
  let previous = '';
  for (const ch of text) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === '<' && /[A-Za-z0-9_]/.test(previous)) angle += 1;
    else if (ch === '>' && angle > 0 && previous !== '=') angle -= 1;
    if (ch === ',' && depth === 0 && angle === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
    previous = ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Top-level property names of an object literal's body. */
function objectKeys(text: string): string[] {
  const body = text.trim().startsWith('{') ? text.trim().slice(1, -1) : text;
  return splitTopLevel(body)
    .map((part) => /^([A-Za-z_]\w*)\s*(?::|,|$)/.exec(part.trim())?.[1])
    .filter((k): k is string => typeof k === 'string');
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

// ===========================================================================
// 1. THE DOORS
// ===========================================================================

/**
 * THE THREE DOORS A NOTIFICATION CAN COME THROUGH, and they are the same three
 * `notification-engine-bypass.guard.spec.ts` polices from the other direction.
 * That guard asks «may this file call the door?»; this one asks «what does the
 * door get called WITH, and is the chain behind that value complete?».
 */
interface Door {
  readonly method: string;
  /** The property on the call's object literal that names the notification. */
  readonly typeProp: string;
  readonly kind: 'ENGINE' | 'DIRECT_WRITE' | 'PIPELINE';
}

const DOORS: readonly Door[] = Object.freeze([
  { method: 'handleEvent', typeProp: 'eventType', kind: 'ENGINE' },
  { method: 'createForFamilyOwner', typeProp: 'type', kind: 'DIRECT_WRITE' },
  { method: 'deliverNow', typeProp: 'type', kind: 'PIPELINE' },
]);

export interface DoorSite {
  readonly file: string;
  readonly line: number;
  readonly method: string;
  readonly kind: Door['kind'];
  /** The source text of the type expression, or `null` when the call omits it. */
  readonly raw: string | null;
  /** The event types this site can emit; empty when unresolved. */
  readonly types: readonly string[];
  /** How `types` was decided — reported so a reader can check the inference. */
  readonly how: string;
  /** Top-level keys of the call's object-literal argument: the FACT SLOTS. */
  readonly slots: readonly string[];
  readonly resolved: boolean;
}

/** A file that DECLARES a door owns that door; its own calls are machinery,
 * not production events. Derived from the declaration, never listed. */
function declaresDoor(code: string, method: string): boolean {
  return new RegExp(
    `(?:^|\\n)\\s*(?:private |public |protected |static |readonly |abstract )*(?:async\\s+)?${method}\\s*[(<]`,
  ).test(code);
}

/** `const NAME = 'VALUE'`, anywhere in `src`. A producer that names its type
 * through a shared constant is being MORE careful and must not fall out. */
function stringConstants(files: readonly SourceFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { content } of files) {
    for (const m of stripComments(content).matchAll(/const\s+([A-Za-z_]\w*)\s*=\s*'([^']+)'/g)) {
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/** `export type NAME = 'A' | 'B'` — the union expanded to its members. */
function stringUnion(files: readonly SourceFile[], name: string): string[] | null {
  for (const { content } of files) {
    const m = new RegExp(`type\\s+${name}\\s*=([^;]*);`).exec(stripComments(content));
    if (m) {
      const members = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      if (members.length > 0) return members;
    }
  }
  return null;
}

/** The declared type of `Interface.field`. */
function interfaceFieldType(
  files: readonly SourceFile[],
  iface: string,
  field: string,
): string | null {
  for (const { content } of files) {
    const m = new RegExp(`interface\\s+${iface}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(stripComments(content));
    if (!m) continue;
    const f = new RegExp(`\\b${field}\\??\\s*:\\s*([^;\\n]+)`).exec(m[1]);
    if (f) return f[1].trim();
  }
  return null;
}

/** The nearest enclosing function declaration and its parameter list. */
function enclosingFunction(
  code: string,
  index: number,
): { name: string; params: string[] } | null {
  const before = code.slice(0, index);
  const re = /(?:^|\n)\s*(?:private |public |protected |static |export |async )*([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(before)) !== null) last = m;
  if (!last) return null;
  const open = last.index + last[0].length - 1;
  return { name: last[1], params: splitParameters(balanced(code, open).text) };
}

function parameterIndex(params: readonly string[], name: string): number {
  return params.findIndex((p) => new RegExp(`^${name}\\b`).test(p.replace(/^\s*readonly\s+/, '')));
}

/** String literals passed at `index` to every call of `fn` in `src`. */
function literalsPassedTo(files: readonly SourceFile[], fn: string, index: number): string[] {
  const out = new Set<string>();
  for (const { content } of files) {
    const code = stripComments(content);
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const arg = splitTopLevel(balanced(code, re.lastIndex - 1).text)[index];
      if (arg && /^'[^']+'$/.test(arg)) out.add(arg.slice(1, -1));
    }
  }
  return [...out];
}

/**
 * The default the door's OWN implementation applies when a caller omits the
 * type — `input.type ?? 'RUNTIME_ALERT'` in `PrismaRuntimeAlertRepository`.
 * Read from the declaring file so that changing the default moves this guard
 * with it.
 */
function doorDefault(files: readonly SourceFile[], door: Door): string | null {
  for (const { content } of files) {
    const code = stripComments(content);
    if (!declaresDoor(code, door.method)) continue;
    const m = new RegExp(`input\\.${door.typeProp}\\s*\\?\\?\\s*'([^']+)'`).exec(code);
    if (m) return m[1];
  }
  return null;
}

/**
 * EVERY DOOR SITE IN `src/`, WITH ITS EVENT TYPES RESOLVED.
 *
 * Pure in `files`, so RULE P7 can hand it a codebase that does not exist.
 */
export function findDoorSites(files: readonly SourceFile[]): DoorSite[] {
  const constants = stringConstants(files);
  const sites: DoorSite[] = [];

  for (const { file, content } of files) {
    if (file.startsWith(ENGINE_DIR)) continue;
    const code = stripComments(content);

    for (const door of DOORS) {
      if (declaresDoor(code, door.method)) continue;
      const re = new RegExp(`\\.${door.method}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const { text } = balanced(code, re.lastIndex - 1);
        const line = lineOf(code, m.index);
        const literal = splitTopLevel(text).find((a) => a.trim().startsWith('{'));
        const slots = literal ? objectKeys(literal) : [];
        const propRe = new RegExp(`\\b${door.typeProp}\\s*(?::\\s*([^,\\n}]+)|,)`);
        const pm = literal ? propRe.exec(literal) : null;
        const raw = pm ? (pm[1] === undefined ? door.typeProp : pm[1].trim()) : null;

        let types: string[] = [];
        let how = 'UNRESOLVED';

        if (raw === null && literal === undefined) {
          how = 'FOREIGN_CALL — the argument is not an object literal';
        } else if (raw === null) {
          const fallback = doorDefault(files, door);
          if (fallback) {
            types = [fallback];
            how = `DOOR_DEFAULT (${door.method} applies '${fallback}' when the caller omits ${door.typeProp})`;
          } else how = `NO_${door.typeProp.toUpperCase()} and the door declares no default`;
        } else if (/^'[^']+'$/.test(raw)) {
          types = [raw.slice(1, -1)];
          how = 'LITERAL';
        } else if (constants.has(raw)) {
          types = [constants.get(raw) as string];
          how = `CONST ${raw}`;
        } else if (/^[A-Za-z_]\w*$/.test(raw)) {
          const fn = enclosingFunction(code, m.index);
          const at = fn ? parameterIndex(fn.params, raw) : -1;
          if (fn && at >= 0) {
            types = literalsPassedTo(files, fn.name, at);
            how = `PARAMETER ${fn.name}#${at}`;
          } else how = `identifier '${raw}' is not a parameter of the enclosing function`;
        } else if (/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(raw)) {
          const [obj, field] = raw.split('.');
          const fn = enclosingFunction(code, m.index);
          const at = fn ? parameterIndex(fn.params, obj) : -1;
          const declared = at >= 0 ? (fn as { params: string[] }).params[at].split(':').slice(1).join(':').trim() : null;
          const fieldType = declared ? interfaceFieldType(files, declared, field) : null;
          const members = fieldType ? stringUnion(files, fieldType) : null;
          if (members) {
            types = members;
            how = `UNION ${declared}.${field}: ${fieldType}`;
          } else how = `'${raw}' does not resolve to a closed string union`;
        }

        sites.push({
          file,
          line,
          method: door.method,
          kind: door.kind,
          raw,
          types,
          how,
          slots,
          resolved: types.length > 0,
        });
      }
    }
  }
  return sites;
}

// ===========================================================================
// 2. THE DECISION LAYER'S OWN COPY-KEY TABLE
// ===========================================================================

export interface CopyRuleRegistration {
  readonly key: string;
  readonly audience: 'PARENT' | 'CHILD';
  /** Fact slots on the CONTEXT the rule reads: `c.goal`, `c.streak`, … */
  readonly factSlots: readonly string[];
  /** Merged variables the rule reads: `v.goalTitle`, … */
  readonly variables: readonly string[];
  /** Event types the rule pins itself to, empty when it applies to any. */
  readonly eventTypes: readonly string[];
}

/**
 * THE PROVIDER PRODUCTION ACTUALLY BINDS, found through the DI registration
 * rather than by importing a class this test picked. `NOTIFICATION_DECISION_PROVIDER`
 * is the seam; if a smarter provider is bound tomorrow, this guard reads ITS
 * table on the same day.
 */
export function boundDecisionProviderFile(files: readonly SourceFile[]): string | null {
  let className: string | null = null;
  for (const { content } of files) {
    const m = /provide:\s*NOTIFICATION_DECISION_PROVIDER\s*,\s*useClass:\s*([A-Za-z_]\w*)/.exec(
      stripComments(content),
    );
    if (m) className = m[1];
  }
  if (!className) return null;
  for (const { file, content } of files) {
    if (new RegExp(`class\\s+${className}\\b`).test(stripComments(content))) return file;
  }
  return null;
}

/** `COPY_RULES`, as data, out of the bound provider's source. */
export function parseCopyRules(files: readonly SourceFile[]): CopyRuleRegistration[] {
  const providerFile = boundDecisionProviderFile(files);
  if (!providerFile) return [];
  const source = files.find((f) => f.file === providerFile);
  if (!source) return [];
  const code = stripComments(source.content);
  const start = code.indexOf('COPY_RULES');
  if (start < 0) return [];
  // AFTER THE `=`, not after the name: `const COPY_RULES: readonly CopyRule[] =
  // Object.freeze([…])` puts an empty `[]` in the TYPE ANNOTATION, and a scan
  // that took the first bracket would parse the annotation and find no rules —
  // silently, which is how a guard becomes a no-op.
  const assign = code.indexOf('=', start);
  const open = assign < 0 ? -1 : code.indexOf('[', assign);
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (; end < code.length; end += 1) {
    if (code[end] === '[') depth += 1;
    else if (code[end] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = code.slice(open + 1, end);

  const rules: CopyRuleRegistration[] = [];
  for (const entry of splitTopLevel(body)) {
    const key = /key:\s*'([^']+)'/.exec(entry)?.[1];
    const audience = /audience:\s*'(PARENT|CHILD)'/.exec(entry)?.[1] as 'PARENT' | 'CHILD' | undefined;
    if (!key || !audience) continue;
    const when = entry.slice(entry.indexOf('when:'));
    rules.push({
      key,
      audience,
      factSlots: [...new Set([...when.matchAll(/\bc\.([A-Za-z_]\w*)/g)].map((m) => m[1]))].filter(
        (slot) => slot !== 'event',
      ),
      variables: [...new Set([...when.matchAll(/\bv\.([A-Za-z_]\w*)/g)].map((m) => m[1]))],
      eventTypes: [...new Set([...when.matchAll(/c\.event\.eventType\s*===\s*'([^']+)'/g)].map((m) => m[1]))],
    });
  }
  return rules;
}

// ===========================================================================
// 3. WHAT IS PRODUCIBLE
// ===========================================================================

export interface Producibility {
  /** Event type -> the sites that can emit it. */
  readonly eventTypes: ReadonlyMap<string, readonly DoorSite[]>;
  /** Copy key -> the one-line reason it is reachable. */
  readonly copyKeys: ReadonlyMap<string, string>;
  readonly unresolved: readonly DoorSite[];
}

/**
 * THE MODEL, and it mirrors `RuleBasedNotificationDecisionProvider.copyFor`
 * step for step rather than guessing:
 *
 *   1. `audienceFor` is `COPY_CATALOGUE[type].audience` — so an event type's
 *      audience is the CATALOGUE's, not the producer's opinion.
 *   2. A CONTEXTUAL RULE WINS FIRST, but only if the facts it reads were
 *      supplied. `NotificationContextAssembler` fills `goal`, `streak` and
 *      `reward` from `input` AND NOWHERE ELSE (`goal: input.goal ?? null`), so
 *      a rule that reads `c.goal` is dead unless some producer of an event of
 *      that rule's audience passes `goal:` at the call site. THIS IS THE STEP
 *      THAT CATCHES THE SUBTLEST CASE: three child copy keys are registered in
 *      the rule table, scored, and mapped to a destination, and no producer in
 *      this codebase has ever supplied the fact that selects them.
 *   3. Otherwise the plain type key, when the catalogue has one.
 *   4. Otherwise `GENERIC`.
 */
export function computeProducibility(
  files: readonly SourceFile[],
  catalogue: Readonly<Record<string, { audience: string }>>,
): Producibility {
  const sites = findDoorSites(files);
  const rules = parseCopyRules(files);

  const eventTypes = new Map<string, DoorSite[]>();
  for (const site of sites) {
    for (const type of site.types) {
      const list = eventTypes.get(type) ?? [];
      list.push(site);
      eventTypes.set(type, list);
    }
  }

  const keys = new Map<string, string>();

  // 3. the plain type key
  for (const [type, where] of eventTypes) {
    if (catalogue[type]) {
      keys.set(type, `${where[0].file}:${where[0].line} emits eventType '${type}' (${where[0].how})`);
    }
  }

  // 2. the contextual rules
  for (const rule of rules) {
    const supporting = sites.filter((site) => {
      const audienceMatch = site.types.some((t) => catalogue[t]?.audience === rule.audience);
      if (!audienceMatch) return false;
      if (rule.eventTypes.length > 0 && !site.types.some((t) => rule.eventTypes.includes(t))) return false;
      if (!rule.factSlots.every((slot) => site.slots.includes(slot))) return false;
      if (rule.variables.length > 0 && !site.slots.includes('variables') && rule.factSlots.length === 0) {
        return false;
      }
      return true;
    });
    if (supporting.length > 0) {
      keys.set(
        rule.key,
        `copy rule [${rule.key}] is satisfiable from ${supporting[0].file}:${supporting[0].line}` +
          ` (audience ${rule.audience}, facts [${rule.factSlots.join(', ') || 'none'}])`,
      );
    }
  }

  return { eventTypes, copyKeys: keys, unresolved: sites.filter((s) => !s.resolved) };
}

// ===========================================================================
// 4. THE CLASSIFICATIONS — AND THEY ARE THE AUDIT TRAIL, NOT A MUTE BUTTON
// ===========================================================================

/**
 * `FALLBACK`         the renderer's terminal answer; it has no producer BY
 *                    CONSTRUCTION and having one would be the bug.
 * `TRANSACTIONAL`    a human-initiated transaction or a machine relay below the
 *                    decision — it carries a type somebody else already decided.
 * `SYSTEM`           safety- or integrity-critical, produced through the
 *                    allow-listed direct writer on purpose.
 * `SCHEDULED_DIGEST` assembled by a scheduler out of decisions already taken.
 * `FOREIGN`          not a notification door at all; a same-named method on an
 *                    unrelated service.
 *
 * WHAT IS NOT AN ACCEPTABLE REASON, written down so it cannot be added quietly:
 * "no producer yet", "another work stream", "it is only one key". Every one of
 * those is `PF-E-001` again, and every one of them belongs on the DEFECT LEDGER
 * below, where it stays visible.
 */
type Classification = 'FALLBACK' | 'TRANSACTIONAL' | 'SYSTEM' | 'SCHEDULED_DIGEST' | 'FOREIGN';

interface ClassifiedEntry {
  readonly what: string;
  readonly classification: Classification;
  /** ONE LINE, and it must say something. A reason too short to be a sentence
   * is the same as no reason, and RULE P1 fails it. */
  readonly reason: string;
}

/** Copy keys that legitimately have no producer. */
const CLASSIFIED_COPY_KEYS: readonly ClassifiedEntry[] = Object.freeze([
  {
    what: GENERIC_COPY_KEY,
    classification: 'FALLBACK',
    reason:
      'The renderer’s terminal fallback, returned by copyFor when a producer emits a type the catalogue has no sentence for; a producer that named it directly would be the defect, not the fix.',
  },
]);

/**
 * Door sites whose event type this guard cannot resolve, and why that is
 * correct rather than a hole. RULE P5 fails on any unresolved site that is NOT
 * here, so the analyser can never quietly under-report.
 */
const CLASSIFIED_DOORS: readonly ClassifiedEntry[] = Object.freeze([
  {
    what: 'src/modules/billing/presentation/controllers/stripe-webhook.controller.ts:handleEvent',
    classification: 'FOREIGN',
    reason:
      'StripeWebhookService.handleEvent is Stripe’s own webhook dispatcher — same method name, different service, and it takes a Stripe event rather than a NotificationEventInput.',
  },
  {
    what: 'src/modules/life-intelligence/application/services/quiet-hours-release.service.ts:deliverNow',
    classification: 'TRANSACTIONAL',
    reason:
      'The release arm re-enters deliverNow with `row.type` read back from notification_deliveries — a type the engine already decided and persisted, never a new event.',
  },
  {
    what: 'src/modules/life-intelligence/application/services/smart-notification-integration.service.ts:createForFamilyOwner',
    classification: 'TRANSACTIONAL',
    reason:
      'This IS the delivery pipeline: it hands `candidate.type` to the single writer of `notifications` on the PARENT branch of deliverNow. It relays a decided candidate and decides nothing itself.',
  },
]);

// ===========================================================================
// 5. THE DEFECT LEDGER — REAL GAPS THIS GUARD FOUND, LEFT VISIBLE
// ===========================================================================

/**
 * EVERY ENTRY HERE IS A DEFECT, NOT AN EXEMPTION.
 *
 * A sentence in `COPY_CATALOGUE` is the product saying it intends to send this
 * — `notification-scoring-coverage.spec.ts` makes that argument at length and
 * this file inherits it. Each key below has copy in Arabic and English, a
 * quiet-hours class, two scoring rows and a deep-link destination, and NOTHING
 * IN `src/` CAN PRODUCE IT. Each is paired with an `it.failing` below, so the
 * day a producer is written the suite goes RED and the entry must be deleted:
 * a ledger that can be satisfied by ignoring it is a scoreboard.
 */
interface LedgerEntry {
  readonly copyKey: string;
  /** Where the evidence is. `file:line`, so a reader can check the claim. */
  readonly evidence: string;
  readonly detail: string;
}

const PRODUCERLESS_DEFECT_LEDGER: readonly LedgerEntry[] = Object.freeze([
  /**
   * ==========================================================================
   * EMPTY, AND THAT IS THE POINT OF KEEPING THE LIST.
   * ==========================================================================
   *
   * Fourteen keys have been closed through this ledger. The last three went in
   * SPRINT F1 and are recorded here because a ledger that forgets what it held
   * is a ledger nobody can audit:
   *
   *   `GOAL_DEADLINE_NEAR`   `GoalNudgeService` — an OPEN `achievement_requests`
   *   `GOAL_ALMOST_DONE`     attempt on a program whose `expires_at` is 3..10
   *                          whole minutes away, and a day whose `max_per_day`
   *                          plan is one VERIFIED attempt short. They shipped
   *                          TOGETHER, which is what the first entry's own
   *                          «ships when the entry below does» demanded: they
   *                          share the `c.goal` fact slot, so closing one alone
   *                          would have erased the other's evidence.
   *                          NO MIGRATION ADDED A PROGRESS COLUMN, because the
   *                          progress was never missing — it is a COUNT of
   *                          `VERIFIED` rows, not a column. `goal-nudge.types.ts`
   *                          carries the three rejected alternatives and why each
   *                          one is dead.
   *   `DAILY_GOAL_COMPLETED` `HealthEngineService` — the hydration and activity
   *                          target crossings, which are the only two things in
   *                          `src/` that have ever emitted that name. The Arabic
   *                          name the entry said did not exist is server-owned
   *                          and lives in `notification-nouns.ts`, keyed on the
   *                          originating domain event type; the device-supplied
   *                          `metadata` the entry rightly refused is still
   *                          refused.
   *
   * ADDING AN ENTRY HERE IS ALWAYS ALLOWED AND ALWAYS VISIBLE. RULE P1 fails by
   * name for a key that is neither producible nor classified, and the `it.failing`
   * block below turns every entry into a line in every run's report. What is not
   * allowed is deleting an entry without either a producer or a reasoned
   * classification standing where it stood.
   */
]);

// ===========================================================================
// 6. THE CLIENT HALF — read from the Flutter apps, never edited
// ===========================================================================

interface ClientRouting {
  readonly wireNames: readonly string[];
  readonly routedSurfaces: readonly string[];
}

function readClientRouting(dir: string, routerFile: string): ClientRouting {
  const link = fs.readFileSync(path.join(dir, 'deep_link.dart'), 'utf8');
  const router = fs.readFileSync(path.join(dir, routerFile), 'utf8');
  const enumToWire = new Map<string, string>();
  for (const m of link.matchAll(/DeepLinkSurface\.([A-Za-z_]\w*)\s*=>\s*'([^']+)'/g)) {
    enumToWire.set(m[1], m[2]);
  }
  const routed = new Set<string>();
  for (const m of router.matchAll(/case\s+DeepLinkSurface\.([A-Za-z_]\w*)\s*:/g)) {
    const wire = enumToWire.get(m[1]);
    if (wire) routed.add(wire);
  }
  return { wireNames: [...enumToWire.values()].sort(), routedSurfaces: [...routed].sort() };
}

// ===========================================================================
// 7. THE SUITE
// ===========================================================================

function readSourceFiles(dir: string = SRC): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readSourceFiles(abs));
    else if (entry.name.endsWith('.ts')) {
      out.push({
        file: path.relative(BACKEND_ROOT, abs).split(path.sep).join('/'),
        content: fs.readFileSync(abs, 'utf8'),
      });
    }
  }
  return out;
}

const files = readSourceFiles();
const sites = findDoorSites(files);
const rules = parseCopyRules(files);
const producibility = computeProducibility(files, COPY_CATALOGUE);
const producibleKeys = [...producibility.copyKeys.keys()].sort();
const producibleTypes = [...producibility.eventTypes.keys()].sort();
const classifiedKeys = CLASSIFIED_COPY_KEYS.map((e) => e.what);
const ledgerKeys = PRODUCERLESS_DEFECT_LEDGER.map((e) => e.copyKey);

const parentRouting = readClientRouting(PARENT_APP, 'deep_link_router.dart');
const childRouting = readClientRouting(CHILD_APP, 'child_deep_link_router.dart');
const audienceOf = (key: string): 'PARENT' | 'CHILD' => COPY_CATALOGUE[key].audience as 'PARENT' | 'CHILD';
const surfaceOf = (link: string): string => link.replace('abny://', '').split('/')[0];

describe('ARCHITECTURE GUARD — no producerless production notification', () => {
  // =========================================================================
  // RULE P6 — anti-vacuity, FIRST, because everything else is downstream of it
  // =========================================================================
  describe('RULE P6 — the scan is not vacuously green', () => {
    it('reads a real codebase and finds real doors', () => {
      expect(files.length).toBeGreaterThan(300);
      expect(sites.length).toBeGreaterThanOrEqual(10);
      expect(copyKeys().length).toBeGreaterThanOrEqual(25);
    });

    it('finds the producers this product demonstrably has, in the files that own them', () => {
      // If this list stops matching, the resolver has broken and RULE P1 has
      // been passing for free — the exact failure mode Phase E already caught
      // once. Named files, not a count: a count survives a rewrite that reads
      // the wrong thing.
      const owners = (type: string): string[] =>
        [...new Set((producibility.eventTypes.get(type) ?? []).map((s) => s.file))].sort();

      expect(owners('REWARD_GRANTED')).toEqual([
        'src/modules/events/application/consumers/notification-reward.consumer.ts',
        'src/modules/life-intelligence/application/services/rewards-engine.service.ts',
      ]);
      // SPRINT F1 (DECISION 1) — TWO OWNERS NOW, and they are the same two
      // `REWARD_GRANTED` has had since B4: the outbox announcer and the direct
      // one. The child half used to exist on only the first of them, which is
      // exactly the asymmetry `announceGrant` closed — a child heard about a
      // reward earned through `/events/batch` and heard nothing about one
      // earned through the `/self/*` routes their own app calls.
      expect(owners('REWARD_GRANTED_CHILD')).toEqual([
        'src/modules/events/application/consumers/notification-reward.consumer.ts',
        'src/modules/life-intelligence/application/services/rewards-engine.service.ts',
      ]);
      expect(owners('GOAL_STALLED_PARENT')).toEqual([
        'src/modules/life-intelligence/application/services/stalled-goal.service.ts',
      ]);
      expect(owners('SCREEN_TIME_EXCEEDED')).toEqual([
        'src/modules/life-intelligence/application/services/digital-wellbeing-engine.service.ts',
      ]);
      expect(owners('CHILD_WELLBEING_CHECKIN')).toEqual([
        'src/modules/ai-core/application/services/distress-escalation.service.ts',
      ]);
      expect(owners('QUIET_HOURS_DIGEST')).toEqual([
        'src/modules/life-intelligence/application/services/quiet-hours-release.service.ts',
      ]);
      expect(owners('RUNTIME_ALERT')).toEqual([
        'src/modules/pairing/application/services/runtime-alert.service.ts',
      ]);
    });

    it('exercises every resolution strategy it implements — an unused strategy is an untested one', () => {
      const strategies = sites.map((s) => s.how.split(' ')[0]);
      for (const strategy of ['LITERAL', 'CONST', 'PARAMETER', 'UNION', 'DOOR_DEFAULT']) {
        expect(`${strategy}:${strategies.includes(strategy)}`).toBe(`${strategy}:true`);
      }
      // The one-hop hops actually hopped, rather than resolving to nothing.
      expect(producibility.eventTypes.get('LEVEL_UP')).toBeDefined(); // PARAMETER
      expect(producibility.eventTypes.get('POLICY_VIOLATION')).toBeDefined(); // UNION
      expect(producibility.eventTypes.get('QUIET_HOURS_DIGEST')).toBeDefined(); // CONST
      expect(producibility.eventTypes.get('RUNTIME_ALERT')).toBeDefined(); // DOOR_DEFAULT
    });

    it('reads the DI-bound decision provider’s own copy-rule table', () => {
      // Not an import of a class this test chose — the class the module binds.
      expect(boundDecisionProviderFile(files)).toBe(
        'src/modules/notifications/application/providers/rule-based-notification-decision.provider.ts',
      );
      expect(rules.length).toBeGreaterThanOrEqual(4);
      for (const rule of rules) expect(copyKeys()).toContain(rule.key);
    });

    it('every fact slot a copy rule reads is a slot a producer could actually supply', () => {
      // A rule reading `c.somethingElse` would be unsatisfiable by construction,
      // and would look identical in this guard's output to a rule nobody feeds.
      const input = files.find((f) => f.file.endsWith('notification-context.assembler.ts'));
      expect(input).toBeDefined();
      const declared = new Set(
        [...stripComments((input as SourceFile).content).matchAll(/readonly\s+([A-Za-z_]\w*)\??\s*:/g)].map(
          (m) => m[1],
        ),
      );
      const unfeedable = rules
        .flatMap((r) => r.factSlots.map((slot) => ({ key: r.key, slot })))
        .filter(({ slot }) => !declared.has(slot))
        .map(({ key, slot }) => `${key} reads c.${slot}, which is not a NotificationEventInput field`);
      expect(unfeedable).toEqual([]);
    });
  });

  // =========================================================================
  // RULE P1 — the property this file exists for
  // =========================================================================
  describe('RULE P1 — every copy key is producible, classified, or on the defect ledger', () => {
    it('the three sets EXACTLY partition the catalogue — nothing is silently skipped', () => {
      // This is the ratchet. A key added without a producer lands in none of the
      // three and fails here BY NAME. A ledger entry that gains a producer lands
      // in two and fails here BY NAME. There is no third outcome and no list to
      // remember to update.
      const catalogue = copyKeys();
      const uncovered = catalogue.filter(
        (key) =>
          !producibility.copyKeys.has(key) && !classifiedKeys.includes(key) && !ledgerKeys.includes(key),
      );
      expect(uncovered).toEqual([]);

      const overlapping = catalogue.filter(
        (key) =>
          [producibility.copyKeys.has(key), classifiedKeys.includes(key), ledgerKeys.includes(key)].filter(
            Boolean,
          ).length > 1,
      );
      expect(overlapping).toEqual([]);

      // And no entry names a key the catalogue no longer has.
      expect([...classifiedKeys, ...ledgerKeys].filter((k) => !catalogue.includes(k))).toEqual([]);
      expect(producibleKeys.filter((k) => !catalogue.includes(k))).toEqual([]);
    });

    it('every classification carries a class and a real one-line reason', () => {
      for (const entry of [...CLASSIFIED_COPY_KEYS, ...CLASSIFIED_DOORS]) {
        expect(['FALLBACK', 'TRANSACTIONAL', 'SYSTEM', 'SCHEDULED_DIGEST', 'FOREIGN']).toContain(
          entry.classification,
        );
        // A reason short enough to be nothing IS nothing.
        expect(`${entry.what}:${entry.reason.trim().length > 60}`).toBe(`${entry.what}:true`);
        expect(entry.reason).not.toMatch(/\n/);
      }
      const named = [...CLASSIFIED_COPY_KEYS, ...CLASSIFIED_DOORS].map((e) => e.what);
      expect(named).toHaveLength(new Set(named).size);
    });

    it('every defect-ledger entry names its evidence and says what is missing', () => {
      for (const entry of PRODUCERLESS_DEFECT_LEDGER) {
        expect(copyKeys()).toContain(entry.copyKey);
        expect(`${entry.copyKey}:${entry.detail.trim().length > 60}`).toBe(`${entry.copyKey}:true`);
        expect(entry.evidence).toMatch(/^(src|test)\//);
      }
      expect(ledgerKeys).toHaveLength(new Set(ledgerKeys).size);
    });

    /**
     * THE DEFECT LEDGER, ONE `it.failing` PER KEY.
     *
     * `it.failing` PASSES while the body throws and FAILS the day it stops —
     * the idiom `e2e-15-arabic-safety.golden.spec.ts` already uses in this
     * repository for exactly this purpose. So each gap is named in the report
     * of every run, the suite stays honest about its own state, and closing a
     * gap breaks the build until the entry above is deleted.
     */
    describe('the defect ledger — these keys have copy, scoring and a destination, and NO producer', () => {
      /**
       * SPRINT F1 — THE BRANCH, AND WHY IT IS NOT A WEAKENING.
       *
       * `it.failing.each([])` is not «no tests»: `jest-each` REFUSES an empty
       * table and fails with «called with an empty Array of table data». So an
       * empty ledger — the state this whole mechanism exists to reach — would be
       * indistinguishable from a broken one, and the obvious fix (deleting the
       * block) would have deleted the ratchet with it.
       *
       * BOTH BRANCHES ASSERT. The EMPTY branch states that the ledger is empty
       * AND that the three keys the last entries held are producible, so it goes
       * red if somebody empties the ledger without producing them; the NON-EMPTY
       * branch is the original ratchet, unchanged, and re-registers itself for
       * every entry that is ever added back.
       */
      if (PRODUCERLESS_DEFECT_LEDGER.length === 0) {
        it('is EMPTY — every key in the catalogue is produced or classified with a reason', () => {
          expect(PRODUCERLESS_DEFECT_LEDGER).toEqual([]);
          for (const closed of ['GOAL_DEADLINE_NEAR', 'GOAL_ALMOST_DONE', 'DAILY_GOAL_COMPLETED']) {
            expect(producibleKeys).toContain(closed);
          }
        });
      } else {
        it.failing.each(PRODUCERLESS_DEFECT_LEDGER.map((e) => [e.copyKey, e.detail]))(
          '%s is produced by something in src/',
          (copyKey) => {
            expect(producibleKeys).toContain(copyKey);
          },
        );
      }
    });
  });

  // =========================================================================
  // RULE P5 — nothing unresolved goes unremarked
  // =========================================================================
  it('RULE P5 — every door site resolves its event type, or is classified with a reason', () => {
    const classified = new Set(CLASSIFIED_DOORS.map((e) => e.what));
    const unexplained = producibility.unresolved
      .filter((site) => !classified.has(`${site.file}:${site.method}`))
      .map((site) => `${site.file}:${site.line} .${site.method}(${site.raw ?? ''}) — ${site.how}`);
    expect(unexplained).toEqual([]);

    // And no dead classification: an entry whose site now resolves, or whose
    // file no longer calls that door, is a licence somebody else inherits.
    const dead = CLASSIFIED_DOORS.filter(
      (entry) => !producibility.unresolved.some((s) => `${s.file}:${s.method}` === entry.what),
    ).map((e) => `${e.what} — classified, but no unresolved site matches it any more; delete the entry`);
    expect(dead).toEqual([]);
  });

  // =========================================================================
  // RULE P2 — the decision chain, per producible EVENT TYPE
  // =========================================================================
  describe('RULE P2 — every producible event type can reach a decision', () => {
    it('the set under test is not empty and is discovered, not listed', () => {
      expect(producibleTypes.length).toBeGreaterThanOrEqual(12);
    });

    it.each(producibleTypes)('%s is CLASSIFIED — quiet-hours class, audience, category', (type) => {
      expect(NOTIFICATION_CLASSES[type]).toBeDefined();
    });

    it.each(producibleTypes)('%s has an EXPLICIT row in URGENCY_BY_TYPE', (type) => {
      // `?? DEFAULT_URGENCY` is a safety net; a shipped producer standing on it
      // is a decision nobody made (PF-E-003).
      expect(Object.prototype.hasOwnProperty.call(URGENCY_BY_TYPE, type)).toBe(true);
    });

    it.each(producibleTypes)('%s has an EXPLICIT row in ACHIEVEMENT_BASELINE_BY_TYPE', (type) => {
      expect(Object.prototype.hasOwnProperty.call(ACHIEVEMENT_BASELINE_BY_TYPE, type)).toBe(true);
    });

    it.each(producibleTypes)('%s has its own sentence — it does not fall through to GENERIC', (type) => {
      expect(COPY_CATALOGUE[type]).toBeDefined();
    });

    it.each(producibleTypes)('%s agrees with the class matrix about its category', (type) => {
      expect(COPY_CATALOGUE[type].category).toBe(NOTIFICATION_CLASSES[type].category);
    });
  });

  // =========================================================================
  // RULE P3 — the delivery chain, per producible COPY KEY
  // =========================================================================
  describe('RULE P3 — every producible copy key survives to a tap that lands', () => {
    it('the set under test is not empty', () => {
      expect(producibleKeys.length).toBeGreaterThanOrEqual(12);
      expect(destinationKeys().length).toBe(copyKeys().length);
    });

    it.each(producibleKeys)('%s has an EXPLICIT destination rule', (key) => {
      expect(hasExplicitDestination(key)).toBe(true);
    });

    it.each(producibleKeys)('%s resolves to a routable abny:// link for its own audience', (key) => {
      const link = resolveNotificationDestination({ copyKey: key, audience: audienceOf(key) });
      expect(isValidDeepLink(link)).toBe(true);
    });

    it.each(producibleKeys)('%s has a persistence branch for its audience', (key) => {
      // `deliverNow` is the one place a notification becomes a row, and it
      // routes on audience: PARENT -> `notifications` via the runtime-alert
      // writer, CHILD -> `child_messages` via the approval-gated writer. Read
      // from the pipeline's source so that deleting a branch fails here.
      const pipeline = files.find((f) => f.file.endsWith('smart-notification-integration.service.ts'));
      expect(pipeline).toBeDefined();
      const code = stripComments((pipeline as SourceFile).content);
      const branch =
        audienceOf(key) === 'PARENT' ? /createForFamilyOwner\s*\(/ : /draftAiMessageIfAbsent\s*\(/;
      expect(branch.test(code)).toBe(true);
      expect(/targetAudience\s*===\s*'PARENT'/.test(code)).toBe(true);
    });

    it.each(producibleKeys)('%s lands on a surface its own app can route', (key) => {
      const audience = audienceOf(key);
      const surface = surfaceOf(resolveNotificationDestination({ copyKey: key, audience }));
      const routing = audience === 'PARENT' ? parentRouting : childRouting;
      expect(routing.wireNames).toContain(surface);
      expect(routing.routedSurfaces).toContain(surface);
    });
  });

  // =========================================================================
  // RULE P4 — one vocabulary, three repositories
  // =========================================================================
  describe('RULE P4 — server, parent app and child app agree about `abny://`', () => {
    it('the two client apps parse exactly the surfaces the server can emit', () => {
      const server = [...DEEP_LINK_SURFACES].sort();
      expect(parentRouting.wireNames).toEqual(server);
      expect(childRouting.wireNames).toEqual(server);
    });

    it('both routers answer for every surface — a case nobody wrote is a tap that dies', () => {
      const server = [...DEEP_LINK_SURFACES].sort();
      expect(parentRouting.routedSurfaces).toEqual(server);
      expect(childRouting.routedSurfaces).toEqual(server);
    });

    it('the engine actually attaches the destination it resolves', () => {
      // The link is resolved in `SmartNotificationEngineService` and written
      // under `NOTIFICATION_DEEP_LINK_DATA_KEY`. If that stopped happening,
      // every assertion above would still pass and every tap would still die.
      const engine = fs.readFileSync(
        path.join(SRC, 'modules/notification-engine/application/services/smart-notification-engine.service.ts'),
        'utf8',
      );
      const code = stripComments(engine);
      expect(code).toMatch(/resolveNotificationDestination\s*\(/);
      expect(code).toMatch(/NOTIFICATION_DEEP_LINK_DATA_KEY/);
    });
  });

  // =========================================================================
  // RULE P7 — THE NEGATIVE CONTROL, WIRED IN AND PERMANENT
  // =========================================================================
  describe('RULE P7 — negative control: the detection provably fires', () => {
    /** A minimal synthetic codebase: one catalogue, one provider, one module. */
    const CATALOGUE = {
      WIDGET_EARNED: { audience: 'CHILD' },
      WIDGET_EARNED_PARENT: { audience: 'PARENT' },
      WIDGET_NEARLY: { audience: 'CHILD' },
    } as const;

    const scaffolding: SourceFile[] = [
      {
        file: 'src/modules/x/x.module.ts',
        content: `providers: [{ provide: NOTIFICATION_DECISION_PROVIDER, useClass: FakeProvider }]`,
      },
      {
        file: 'src/modules/x/fake.provider.ts',
        // THE SAME SHAPE AS PRODUCTION, deliberately — type annotation, empty
        // `[]` inside it, and `Object.freeze`. A control written in a simpler
        // shape than the artefact it stands in for proves nothing about the
        // artefact, and this one caught a real parser bug on its first run.
        content: `
const COPY_RULES: readonly CopyRule[] = Object.freeze([
  { key: 'WIDGET_NEARLY', audience: 'CHILD', when: (c, v) => c.goal !== null && c.goal.totalUnits > 0 },
]);
export class FakeProvider {}`,
      },
    ];

    const producerOf = (eventType: string, extra = ''): SourceFile => ({
      file: 'src/modules/x/x.service.ts',
      content: `async go() { await this.notifications.handleEvent({ familyId, childId, eventType: '${eventType}', sourceEventId, trigger: 'DOMAIN_EVENT'${extra} }); }`,
    });

    it('a copy key with NO producer is reported BY NAME', () => {
      const result = computeProducibility([...scaffolding, producerOf('WIDGET_EARNED')], CATALOGUE);
      const producerless = Object.keys(CATALOGUE).filter((k) => !result.copyKeys.has(k));
      expect(producerless).toContain('WIDGET_EARNED_PARENT');
      expect(producerless).not.toContain('WIDGET_EARNED');
    });

    it('adding the producer clears the report — the guard is discriminating, not indiscriminate', () => {
      const both = [
        ...scaffolding,
        producerOf('WIDGET_EARNED'),
        {
          file: 'src/modules/x/y.service.ts',
          content: `async go() { await this.notifications.handleEvent({ familyId, eventType: 'WIDGET_EARNED_PARENT', sourceEventId, trigger: 'DOMAIN_EVENT' }); }`,
        },
      ];
      const result = computeProducibility(both, CATALOGUE);
      expect(Object.keys(CATALOGUE).filter((k) => !result.copyKeys.has(k))).toEqual(['WIDGET_NEARLY']);
    });

    it('a contextual copy key whose FACT SLOT nobody supplies is producerless — the subtle case', () => {
      // This is the case a "is the key in the rule table?" guard gets wrong, and
      // it is the shape of three real gaps in this repository today.
      const withoutFact = computeProducibility([...scaffolding, producerOf('WIDGET_EARNED')], CATALOGUE);
      expect(withoutFact.copyKeys.has('WIDGET_NEARLY')).toBe(false);

      const withFact = computeProducibility(
        [...scaffolding, producerOf('WIDGET_EARNED', ', goal: { title, completedUnits, totalUnits }')],
        CATALOGUE,
      );
      expect(withFact.copyKeys.has('WIDGET_NEARLY')).toBe(true);
    });

    it('a fact supplied for the WRONG AUDIENCE does not make a child rule producible', () => {
      const parentOnly = computeProducibility(
        [
          ...scaffolding,
          {
            file: 'src/modules/x/p.service.ts',
            content: `async go() { await this.notifications.handleEvent({ familyId, eventType: 'WIDGET_EARNED_PARENT', sourceEventId, trigger: 'PERIODIC_SIGNAL', goal: { title } }); }`,
          },
        ],
        CATALOGUE,
      );
      expect(parentOnly.copyKeys.has('WIDGET_NEARLY')).toBe(false);
    });

    it('an unresolvable event type is REPORTED, never silently dropped', () => {
      const opaque = computeProducibility(
        [
          ...scaffolding,
          {
            file: 'src/modules/x/z.service.ts',
            content: `async go(row) { await this.notifications.handleEvent({ familyId, eventType: row.type, sourceEventId, trigger: 'DOMAIN_EVENT' }); }`,
          },
        ],
        CATALOGUE,
      );
      expect(opaque.unresolved.map((s) => `${s.file}:${s.method}`)).toContain('src/modules/x/z.service.ts:handleEvent');
    });

    it('PROSE that names a producer is not a producer — the comment strip is load-bearing', () => {
      const prose: SourceFile = {
        file: 'src/modules/x/notes.ts',
        content: [
          `/** It used to call handleEvent({ eventType: 'WIDGET_EARNED_PARENT' }) and that was the defect. */`,
          `// this.notifications.handleEvent({ eventType: 'WIDGET_EARNED_PARENT' }) — deliberately not done`,
          `const NOTE = "handleEvent({ eventType: 'WIDGET_EARNED_PARENT' })";`,
        ].join('\n'),
      };
      const result = computeProducibility([...scaffolding, prose], CATALOGUE);
      expect(result.copyKeys.has('WIDGET_EARNED_PARENT')).toBe(false);
    });

    it('a `/*` inside a line comment does not blind the scanner to the next forty lines', () => {
      // MEASURED, NOT IMAGINED: `rewards-engine.service.ts:384` carries
      // `// DIRECT \`/self/*\` path …`, and a regex-chain stripper swallows
      // everything up to the next `*/` — including the REWARD_GRANTED producer
      // thirty-eight lines later.
      const tricky: SourceFile = {
        file: 'src/modules/x/tricky.service.ts',
        content: [
          '// the DIRECT `/self/*` path there is nothing to retry with',
          '/** a real docstring, closed normally */',
          `async go() { await this.notifications.handleEvent({ familyId, eventType: 'WIDGET_EARNED_PARENT', sourceEventId, trigger: 'DOMAIN_EVENT' }); }`,
        ].join('\n'),
      };
      const result = computeProducibility([...scaffolding, tricky], CATALOGUE);
      expect(result.copyKeys.has('WIDGET_EARNED_PARENT')).toBe(true);
    });

    it('an unreasoned classification is rejected by the same assertion the real list faces', () => {
      const bad: ClassifiedEntry[] = [
        { what: 'K', classification: 'FALLBACK', reason: 'because' },
        { what: 'K2', classification: 'SYSTEM', reason: '' },
      ];
      for (const entry of bad) {
        expect(entry.reason.trim().length > 60).toBe(false);
      }
      // …and the real ones pass it, which is what makes the assertion meaningful.
      for (const entry of [...CLASSIFIED_COPY_KEYS, ...CLASSIFIED_DOORS]) {
        expect(entry.reason.trim().length > 60).toBe(true);
      }
    });
  });
});
