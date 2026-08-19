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
 *   `notification-source-key.ts`   the DOCUMENTED FORMS of a causal key —
 *                                  `causalKeyComposers` reads the exported
 *                                  function names, so a seventh form moves
 *                                  RULE P12 with it.
 *   `deep_link.dart` x2            the CLIENT half of `abny://`, in both
 *   `*_deep_link_router.dart`      Flutter apps — read as text, never edited,
 *                                  and now read as ROUTERS: the RETURNS of each
 *                                  `case`, not merely its label, because a case
 *                                  that answers `unavailable()` is a dead tap
 *                                  with a line number (RULE P11).
 *
 * Add a copy key and no producer: RULE P1 goes red naming the key. Add a
 * producer whose type has no scoring row: RULE P2 goes red naming the key. Add
 * a destination the child app cannot service: RULE P4 goes red naming the
 * surface. Add a key with no Arabic sentence, no audience, no quiet-hours class,
 * a screen its own app refuses to open, or a causal key invented at the call
 * site: RULES P8..P12 go red naming the key. Nobody has to remember anything.
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
 *       It covers P8..P12 too, one broken property at a time, in both
 *       directions.
 *
 * ---------------------------------------------------------------------------
 * AND THE SECOND INVARIANT: A PRODUCER IS NOT ENOUGH.
 *
 * P1..P7 answer «can anything cause this sentence to be sent». They are
 * satisfiable by a key that is produced and then lands nowhere, says nothing in
 * Arabic, claims no audience, has no quiet-hours class, and cannot be traced to
 * the occurrence it is about. Each of those has shipped in this repository. So
 * every PRODUCIBLE key must also carry:
 *
 *   P8   A DECLARED AUDIENCE — PARENT or CHILD in the catalogue, agreeing with
 *        `notification-class.ts` wherever both speak.
 *   P9   ARABIC COPY — present, non-empty, and actually in Arabic script, in
 *        every variant its own audience is rendered with (all four tone bands
 *        for a child key, because the nearest-band walk hides a missing one).
 *   P10  A SAFETY CLASSIFICATION — a written `NOTIFICATION_CLASSES` row, its
 *        own or that of every type it can be selected under. Never
 *        `DEFAULT_QUIET_HOURS_CLASS`, which its own docstring calls «a safety
 *        net and never an answer».
 *   P11  A DESTINATION THE APP ANSWERS — not merely a `case` in the router, but
 *        a `case` that builds a route. The taps that die are on
 *        `DEAD_DESTINATION_LEDGER` with an `it.failing` each.
 *   P12  PROVENANCE — a named producing site, composing its causal key through
 *        one of `notification-source-key.ts`'s documented forms rather than
 *        inventing one, so «which occurrence is this?» has an answer in a row.
 *
 * THE SET UNDER AUDIT IS DISCOVERED, NOT LISTED: it is exactly the producible
 * set P1 computes, so a key added tomorrow is audited tomorrow.
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

/**
 * The VALUE text of ONE top-level property, ACROSS NEWLINES.
 *
 * `objectKeys` answers «was this slot filled at all», which is what the copy
 * rules need. RULE P11 needs the OTHER half — WITH WHAT — and the causal key it
 * reads is routinely written over four lines (`goal-nudge.service.ts` composes
 * `forEntity(...)` with one argument per line). A line-bounded regex would read
 * `forEntity(` and conclude the producer invented something.
 *
 * Shorthand (`{ sourceEventId }`) returns the identifier, which is what it is:
 * a relay of a value composed somewhere else.
 */
function objectProperty(text: string, name: string): string | null {
  const body = text.trim().startsWith('{') ? text.trim().slice(1, -1) : text;
  for (const part of splitTopLevel(body)) {
    const trimmed = part.trim();
    const m = new RegExp(`^${name}\\s*(?::([\\s\\S]*)|$)`).exec(trimmed);
    if (m) return (m[1] ?? name).trim() || name;
  }
  return null;
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
  /**
   * The source text of the `sourceEventId` argument — the CAUSAL KEY, which is
   * this product's whole answer to «which occurrence is this?». Read as text
   * rather than as a boolean because RULE P11 asks HOW it was composed, and a
   * key invented at the call site (`\`evt:${x}\``) and one composed through
   * `notification-source-key.ts` are the same shape to a slot check and
   * opposites to an operator tracing a duplicate.
   */
  readonly sourceExpression: string | null;
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
          sourceExpression: literal ? objectProperty(literal, 'sourceEventId') : null,
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
  /**
   * Copy key -> the door sites that can put it on somebody's screen. The
   * PRODUCERS of a key, as opposed to the producers of a TYPE: `REWARD_GRANTED`
   * and `REWARD_GRANTED_WITH_GOAL` are two sentences behind one type and one of
   * them is chosen by a rule, so «who produces this SENTENCE» is a different
   * question from «who emits this TYPE» and RULE P11 asks the first.
   */
  readonly copyKeySites: ReadonlyMap<string, readonly DoorSite[]>;
  /**
   * Copy key -> the EVENT TYPES under which the decision layer can select it.
   * For a plain catalogue key that is the key itself; for a contextual rule it
   * is every type whose producer supplies the facts the rule reads. This is the
   * map RULE P10 resolves a safety classification through, because four copy
   * keys in this catalogue are NOT notification types and therefore have no
   * `NOTIFICATION_CLASSES` row of their own.
   */
  readonly copyKeyTypes: ReadonlyMap<string, readonly string[]>;
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
  const keySites = new Map<string, DoorSite[]>();
  const keyTypes = new Map<string, string[]>();

  // 3. the plain type key
  for (const [type, where] of eventTypes) {
    if (catalogue[type]) {
      keys.set(type, `${where[0].file}:${where[0].line} emits eventType '${type}' (${where[0].how})`);
      keySites.set(type, [...where]);
      keyTypes.set(type, [type]);
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
      keySites.set(rule.key, [...(keySites.get(rule.key) ?? []), ...supporting]);
      // THE TYPES THE RULE CAN ACTUALLY FIRE UNDER, not every type its
      // producers emit: a site that emits two types only lends this rule the
      // one whose catalogue audience the rule is written for.
      keyTypes.set(rule.key, [
        ...new Set([
          ...(keyTypes.get(rule.key) ?? []),
          ...supporting.flatMap((site) =>
            site.types.filter(
              (t) =>
                catalogue[t]?.audience === rule.audience &&
                (rule.eventTypes.length === 0 || rule.eventTypes.includes(t)),
            ),
          ),
        ]),
      ]);
    }
  }

  return {
    eventTypes,
    copyKeys: keys,
    copyKeySites: keySites,
    copyKeyTypes: keyTypes,
    unresolved: sites.filter((s) => !s.resolved),
  };
}

// ===========================================================================
// 3b. WHAT A KEY MUST CARRY BESIDES A PRODUCER
// ===========================================================================

/**
 * ===========================================================================
 * THE SECOND INVARIANT, AND WHY «A PRODUCER EXISTS» WAS NEVER ENOUGH.
 * ===========================================================================
 *
 * RULES P1..P7 decide one thing: can anything in `src/` cause this sentence to
 * be sent. That is the question `PF-E-001` and `PF-E-006` were, and it is now
 * answered for every key in the catalogue. It is also, on its own, satisfiable
 * by a key that is produced and then lands nowhere, says nothing in Arabic,
 * claims no audience, has no quiet-hours class and cannot be traced back to the
 * occurrence that caused it. Each of those has shipped here:
 *
 *   `CHILD_WELLBEING_CHECKIN`  produced, scored, classified, delivered — and
 *                              its destination was `abny://coach`, which the
 *                              parent app answers `DeepLinkRouteKind.unavailable`.
 *                              A tap on the most important sentence this
 *                              product sends did nothing. It was found by
 *                              READING the router, not by reading the surface
 *                              list, which is why RULE P9 reads the router too.
 *   `GOAL_COMPLETED_PARENT`    copy in two languages and NO `NOTIFICATION_CLASSES`
 *                              row (`PF-E-003`), so its quiet-hours behaviour
 *                              was the unconsidered default and its per-category
 *                              cap counted against the raw type string.
 *   `RUNTIME_ALERT`            a sentence written for a type whose producers do
 *                              not reach the composer — visible here as a key
 *                              whose destination is the inbox BY DECISION, and
 *                              the reason RULE P9 distinguishes «the inbox is
 *                              the correct answer» from «the app cannot open
 *                              this».
 *
 * SO: FIVE MORE PROPERTIES, PER KEY, EACH READ OUT OF A PRODUCTION ARTEFACT AND
 * EACH WITH A NEGATIVE CONTROL UNDER RULE P7. The analysers below are PURE
 * FUNCTIONS OF THEIR ARGUMENTS — no `fs`, no imports of the real catalogue —
 * for exactly the reason `computeProducibility` is: a check that can only be
 * run against the real repository is a check nobody can prove discriminates.
 *
 * EVERY ONE OF THEM RETURNS FINDINGS BY NAME. `expect(findings).toEqual([])`
 * prints the key and what it is missing; `expect(count).toBe(0)` prints
 * «expected 0, received 2», and the second is how a guard becomes a thing
 * people delete.
 */

/** The catalogue shape these analysers need, and nothing else of it. */
export interface QualityCatalogueEntry {
  readonly category: string;
  readonly audience: string;
  readonly variants: Readonly<
    Record<string, Readonly<Record<string, { readonly title: string; readonly body: string }>>>
  >;
}

/** The class-matrix shape these analysers need. */
export interface QualityClassEntry {
  readonly quietHours: string;
  readonly audience: string;
  readonly category: string;
  readonly why: string;
}

export interface KeyQualityInput {
  /** The keys under audit — the PRODUCIBLE ones. A classified non-producer has
   * no audience to serve and no tap to land. */
  readonly keys: readonly string[];
  readonly catalogue: Readonly<Record<string, QualityCatalogueEntry>>;
  readonly classes: Readonly<Record<string, QualityClassEntry>>;
  /** Copy key -> the event types the decision layer can select it under. */
  readonly selectableUnder: ReadonlyMap<string, readonly string[]>;
  /** Copy key -> the door sites that can produce it. */
  readonly producedBy: ReadonlyMap<string, readonly DoorSite[]>;
  /** The link the server would emit, or `null` when no explicit rule exists. */
  readonly destinationOf: (key: string, audience: string) => string | null;
  /** Audience -> the surfaces that audience's app can actually OPEN. */
  readonly answeredSurfaces: Readonly<Record<string, readonly string[]>>;
  /** The composer names `notification-source-key.ts` exports. */
  readonly causalKeyComposers: readonly string[];
}

/** The two audiences this product has. `BOTH` is a CLASS-matrix word: the
 * catalogue splits a both-audience fact into two keys, because `audience` is a
 * property of the ENTRY there. */
const AUDIENCES = ['PARENT', 'CHILD'] as const;

/** The four child tone bands, in the order `notification-tone.ts` declares
 * them. Read as a constant here rather than imported so a synthetic fixture can
 * be audited without the real tone module. */
const TONE_BANDS = ['5-7', '8-10', '11-13', '14-17'] as const;

/** Arabic script. One test, used for «is the `ar` slot actually Arabic». */
const ARABIC_LETTER = /[؀-ۿ]/;

/** The surface half of an `abny://` link. */
const surfaceOfLink = (link: string): string => link.replace('abny://', '').split('/')[0];

/**
 * RULE P8 — A DECLARED AUDIENCE.
 *
 * WHO IS THIS FOR is the first thing every other layer asks: it chooses the
 * inbox the fatigue history is read from (`readHistory`), the table the row is
 * written to (`deliverNow`), the safety filter that validates the words
 * (`NotificationComposerService.validate`) and the app the tap is routed in. A
 * key that does not answer it is not under-specified, it is unroutable — and
 * the catalogue's own `resolveTargetAudience` would guess from «is there a
 * child in the context», which is how a billing notice reaches a seven-year-old.
 *
 * AND IT MUST AGREE WITH THE CLASS MATRIX where the key is also a type. `BOTH`
 * admits either, and that is not a loophole: `BOTH` means the PRODUCER composes
 * two candidates with two facets, each carrying a single-audience key.
 */
export function keysWithoutDeclaredAudience(input: KeyQualityInput): string[] {
  const findings: string[] = [];
  for (const key of input.keys) {
    const entry = input.catalogue[key];
    if (!entry) {
      findings.push(`${key} — no catalogue entry at all`);
      continue;
    }
    if (!(AUDIENCES as readonly string[]).includes(entry.audience)) {
      findings.push(`${key} — declares audience '${entry.audience ?? 'none'}', which is not PARENT or CHILD`);
      continue;
    }
    const klass = input.classes[key];
    if (klass && klass.audience !== 'BOTH' && klass.audience !== entry.audience) {
      findings.push(
        `${key} — the catalogue says ${entry.audience} and notification-class.ts says ${klass.audience}`,
      );
    }
  }
  return findings;
}

/**
 * RULE P9 — ARABIC COPY, PRESENT AND NON-EMPTY.
 *
 * CONTEXT §1: Arabic is the product's first language and `ar` is the renderer's
 * fallback locale — `renderNotificationCopy` reads `localised[locale] ?? localised.ar`,
 * so an `ar` variant that is missing is not «English is used instead», it is a
 * CRASH-SHAPED HOLE that degrades the whole notification to `GENERIC`. An `ar`
 * slot holding an English sentence is worse than a missing one, because nothing
 * downstream can tell.
 *
 * WHAT IS CHECKED, per key:
 *   * the variant its audience will actually be rendered with EXISTS — `PARENT`
 *     for a parent key, and ALL FOUR TONE BANDS for a child one. The four are
 *     required rather than one-plus-`BAND_FALLBACK`, because the fallback walk
 *     makes a missing band INVISIBLE while a six-year-old reads a sixteen-year-
 *     old's sentence, and «age-aware, never shaming» is a product rule rather
 *     than a rendering convenience;
 *   * every declared variant has an `ar` template;
 *   * its title and body are non-empty after trimming;
 *   * they contain Arabic script — an English literal parked in an `ar` slot is
 *     reported by name.
 */
export function keysWithoutArabicCopy(input: KeyQualityInput): string[] {
  const findings: string[] = [];
  for (const key of input.keys) {
    const entry = input.catalogue[key];
    if (!entry) {
      findings.push(`${key} — no catalogue entry at all`);
      continue;
    }
    const required = entry.audience === 'PARENT' ? ['PARENT'] : [...TONE_BANDS];
    for (const variantKey of required) {
      if (!entry.variants?.[variantKey]) {
        findings.push(`${key} — no '${variantKey}' variant, which is the one its own audience is rendered with`);
      }
    }
    for (const [variantKey, localised] of Object.entries(entry.variants ?? {})) {
      const ar = localised?.ar;
      if (!ar) {
        findings.push(`${key}/${variantKey} — no 'ar' template, and 'ar' is the renderer's fallback locale`);
        continue;
      }
      for (const field of ['title', 'body'] as const) {
        const text = ar[field];
        if (typeof text !== 'string' || text.trim().length === 0) {
          findings.push(`${key}/${variantKey} — the Arabic ${field} is empty`);
        } else if (!ARABIC_LETTER.test(text)) {
          findings.push(`${key}/${variantKey} — the Arabic ${field} contains no Arabic letter: «${text}»`);
        }
      }
    }
  }
  return findings;
}

/**
 * RULE P10 — A SAFETY CLASSIFICATION, AND NEVER THE DEFAULT.
 *
 * `notification-class.ts` is where this product decides what a notification
 * does at 02:00, and its three answers are safety decisions: SUPPRESS drops a
 * fact whose premise expires overnight, DEFER holds one that survives it,
 * DELIVER wakes a household. `DEFAULT_QUIET_HOURS_CLASS` exists so that a type
 * nobody classified fails towards being KEPT — its own docstring calls it «a
 * safety net and never an answer», and a shipped key standing on it is a
 * decision nobody made.
 *
 * FOUR KEYS IN THIS CATALOGUE ARE NOT TYPES — `GOAL_ALMOST_DONE`,
 * `GOAL_DEADLINE_NEAR`, `STREAK_AT_RISK`, `REWARD_GRANTED_WITH_GOAL` are
 * SENTENCES the decision layer may select under some other type — so the class
 * is resolved the way production resolves it: through the TYPE the row is
 * written with. A key is classified when it has a row of its own, or when every
 * event type it can be selected under has one. `why` must say something, for
 * the reason every reason in this file must.
 */
export function keysWithoutSafetyClassification(input: KeyQualityInput): string[] {
  const findings: string[] = [];
  const classified = (type: string): boolean =>
    Object.prototype.hasOwnProperty.call(input.classes, type) &&
    typeof input.classes[type].quietHours === 'string' &&
    input.classes[type].quietHours.length > 0 &&
    typeof input.classes[type].why === 'string' &&
    input.classes[type].why.trim().length > 60;

  for (const key of input.keys) {
    if (classified(key)) continue;
    const types = input.selectableUnder.get(key) ?? [];
    if (types.length === 0) {
      findings.push(
        `${key} — no notification-class.ts row of its own and no event type it can be selected under`,
      );
      continue;
    }
    const unclassified = types.filter((type) => !classified(type));
    if (unclassified.length > 0) {
      findings.push(
        `${key} — falls back to DEFAULT_QUIET_HOURS_CLASS under [${unclassified.sort().join(', ')}]`,
      );
    }
  }
  return findings;
}

/**
 * RULE P11 — A DESTINATION THE APP ACTUALLY ANSWERS.
 *
 * THE DISTINCTION THIS FUNCTION EXISTS FOR, and the one the previous check
 * could not make. RULE P3 already asked «does the surface appear in the
 * router's switch?». `CHILD_WELLBEING_CHECKIN` passed that check while its tap
 * did nothing, because `abny://coach` DOES appear in `deep_link_router.dart` —
 * it appears as `return DeepLinkRoute.unavailable()`. A case that exists and
 * answers «no screen» is a dead tap with a line number.
 *
 * So the surfaces are read from the ROUTER'S RETURNS: a surface is ANSWERED
 * when at least one branch of its case builds a route, and UNANSWERED when
 * every branch is `unavailable()`. Read, never listed — `DEEP_LINK_SURFACES`
 * says what the server may emit and says nothing about what a client can open.
 *
 * THE INBOX IS AN ANSWER. `RUNTIME_ALERT`, `QUIET_HOURS_DIGEST` and `GENERIC`
 * resolve to `abny://notifications` BY DECISION — a digest of N things cannot
 * point at one of them — and both apps route it. The check is «can this tap
 * land», not «is this tap interesting».
 */
export function keysWithDeadDestination(input: KeyQualityInput): string[] {
  const findings: string[] = [];
  for (const key of input.keys) {
    const audience = input.catalogue[key]?.audience;
    if (!(AUDIENCES as readonly string[]).includes(audience)) continue; // RULE P8's finding, not this one
    const link = input.destinationOf(key, audience);
    if (link === null) {
      findings.push(`${key} — no explicit destination rule; every tap falls to the inbox by accident`);
      continue;
    }
    const surface = surfaceOfLink(link);
    const answered = input.answeredSurfaces[audience] ?? [];
    if (!answered.includes(surface)) {
      findings.push(
        `${key} — resolves to ${link}, and the ${audience} app answers '${surface}' with no screen (a dead tap)`,
      );
    }
  }
  return findings;
}

/**
 * RULE P12 — PROVENANCE: THE OCCURRENCE THIS SENTENCE IS ABOUT.
 *
 * `notifications.source_event_id` is NOT NULL and unique per recipient, and
 * `notification_decisions` joins to it — so the causal key is the whole of this
 * product's answer to «is this the same notification?», «why did this household
 * get two?» and «what caused the row I am looking at?». `B9` added the
 * constraint precisely because a five-minute `findFirst` window is not one.
 *
 * WHAT MAKES A KEY TRACEABLE, and both halves are checked:
 *
 *   1. IT HAS A NAMED PRODUCER. A `file:line` a reader can open. A key that is
 *      producible only in the abstract is a key nobody can audit.
 *   2. ITS PRODUCERS COMPOSE THE KEY RATHER THAN INVENT IT.
 *      `notification-source-key.ts` exports the documented forms —
 *      `forDomainEvent`, `forEntity`, `forRecurringSignal`,
 *      `forQuietHoursDigest`, `forBillingEvent`, `forAudience` — and the
 *      composer list is READ OUT OF THAT FILE, so adding a seventh form moves
 *      this check with it. A string or template literal written at the call
 *      site is REPORTED: it is a key whose collision behaviour nobody reasoned
 *      about, and the header of that module spends four hundred lines arguing
 *      that the composition is the decision. A bare identifier or member
 *      expression (`input.sourceEventId`) is ACCEPTED — that is a relay of a
 *      key composed upstream, which is what `BillingNotificationProducer.tell`
 *      and the quiet-hours release arm both are.
 */
export function keysWithoutProvenance(input: KeyQualityInput): string[] {
  const findings: string[] = [];
  const composers = new Set(input.causalKeyComposers);
  for (const key of input.keys) {
    const sites = input.producedBy.get(key) ?? [];
    if (sites.length === 0) {
      findings.push(`${key} — producible, but no door site names it: there is nothing to quote`);
      continue;
    }
    for (const site of sites) {
      const where = `${site.file}:${site.line}`;
      const expression = site.sourceExpression;
      if (expression === null) {
        findings.push(`${key} — ${where} states no sourceEventId, so the occurrence it is about is unrecorded`);
        continue;
      }
      if (/^['"`]/.test(expression)) {
        findings.push(
          `${key} — ${where} invents its causal key in place (${expression.split('\n')[0]}) instead of` +
            ` composing it through notification-source-key.ts`,
        );
        continue;
      }
      const call = /^([A-Za-z_]\w*)\s*\(/.exec(expression);
      if (call && !composers.has(call[1])) {
        findings.push(
          `${key} — ${where} composes its causal key with '${call[1]}', which notification-source-key.ts does not export`,
        );
      }
    }
  }
  return findings;
}

/** The composer names `notification-source-key.ts` exports, read from it. */
export function causalKeyComposers(files: readonly SourceFile[]): string[] {
  const source = files.find((f) => f.file.endsWith('shared/notifications/notification-source-key.ts'));
  if (!source) return [];
  return [...stripComments(source.content).matchAll(/export\s+function\s+([A-Za-z_]\w*)\s*\(/g)].map(
    (m) => m[1],
  );
}

// ===========================================================================
// 4. THE CLASSIFICATIONS — AND THEY ARE THE AUDIT TRAIL, NOT A MUTE BUTTON
// ===========================================================================

/**
 * ===========================================================================
 * THE NON-PRODUCER VOCABULARY FOR A COPY KEY. FOUR WORDS, CLOSED.
 * ===========================================================================
 *
 * `SYSTEM_ONLY`           the key exists for a system or integrity path that
 *                         writes through the allow-listed direct writer, not
 *                         through a business event.
 * `TRANSACTIONAL_ONLY`    the key is relayed with a type somebody else already
 *                         decided — a machine hop below the decision layer.
 * `NO_PRODUCER_BY_DESIGN` having a producer would be the DEFECT. The renderer's
 *                         terminal fallback is the only member today.
 * `DEFERRED`              a decided product intention whose producer is a later
 *                         piece of work, named here with the work that closes it.
 *
 * `DEFERRED` IS NOT AN EXEMPTION AND IT IS NOT THE LEDGER'S REPLACEMENT. It is
 * for a key the product has DECIDED not to produce yet; a key that was supposed
 * to be produced and is not is a DEFECT and belongs on `PRODUCERLESS_DEFECT_LEDGER`
 * below, where an `it.failing` names it in every run's report. The difference is
 * whether somebody decided, and the reason has to say so.
 *
 * WHAT IS NOT AN ACCEPTABLE REASON, written down so it cannot be added quietly:
 * "no producer yet", "another work stream", "it is only one key". Every one of
 * those is `PF-E-001` again.
 */
type KeyClassification = 'SYSTEM_ONLY' | 'TRANSACTIONAL_ONLY' | 'NO_PRODUCER_BY_DESIGN' | 'DEFERRED';

/**
 * The DOOR vocabulary, which is a different question and keeps its own words: a
 * door classification says why an event type could not be RESOLVED at a call
 * site, not why a sentence has no producer.
 *
 * `FALLBACK`         the renderer's terminal answer; it has no producer BY
 *                    CONSTRUCTION and having one would be the bug.
 * `TRANSACTIONAL`    a human-initiated transaction or a machine relay below the
 *                    decision — it carries a type somebody else already decided.
 * `SYSTEM`           safety- or integrity-critical, produced through the
 *                    allow-listed direct writer on purpose.
 * `SCHEDULED_DIGEST` assembled by a scheduler out of decisions already taken.
 * `FOREIGN`          not a notification door at all; a same-named method on an
 *                    unrelated service.
 */
type DoorClassification = 'FALLBACK' | 'TRANSACTIONAL' | 'SYSTEM' | 'SCHEDULED_DIGEST' | 'FOREIGN';

interface ClassifiedEntry<C extends string = string> {
  readonly what: string;
  readonly classification: C;
  /** ONE LINE, and it must say something. A reason too short to be a sentence
   * is the same as no reason, and RULE P1 fails it. */
  readonly reason: string;
}

/** Copy keys that legitimately have no producer. */
const CLASSIFIED_COPY_KEYS: readonly ClassifiedEntry<KeyClassification>[] = Object.freeze([
  {
    what: GENERIC_COPY_KEY,
    classification: 'NO_PRODUCER_BY_DESIGN',
    reason:
      'The renderer’s terminal fallback, returned by copyFor when a producer emits a type the catalogue has no sentence for; a producer that named it directly would be the defect, not the fix.',
  },
]);

const KEY_CLASSIFICATIONS: readonly KeyClassification[] = [
  'SYSTEM_ONLY',
  'TRANSACTIONAL_ONLY',
  'NO_PRODUCER_BY_DESIGN',
  'DEFERRED',
];

const DOOR_CLASSIFICATIONS: readonly DoorClassification[] = [
  'FALLBACK',
  'TRANSACTIONAL',
  'SYSTEM',
  'SCHEDULED_DIGEST',
  'FOREIGN',
];

/**
 * Door sites whose event type this guard cannot resolve, and why that is
 * correct rather than a hole. RULE P5 fails on any unresolved site that is NOT
 * here, so the analyser can never quietly under-report.
 */
const CLASSIFIED_DOORS: readonly ClassifiedEntry<DoorClassification>[] = Object.freeze([
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
// 5b. THE DEAD-DESTINATION LEDGER — TAPS THAT DIE, LEFT VISIBLE
// ===========================================================================

/**
 * ===========================================================================
 * EVERY ENTRY HERE IS A DEFECT, NOT AN EXEMPTION — the same contract as
 * `PRODUCERLESS_DEFECT_LEDGER`, for the same reason, with the same ratchet.
 * ===========================================================================
 *
 * A key on this list is PRODUCED, CLASSIFIED, SCORED, has Arabic copy and an
 * explicit destination rule — and its destination is a surface its own app
 * answers with `DeepLinkRouteKind.unavailable`. The notification arrives, the
 * reader taps it, and the app shows them the inbox they were already in with a
 * snackbar saying it cannot open that. This repository has shipped that before
 * on `CHILD_WELLBEING_CHECKIN` (`abny://coach`), which is why RULE P11 reads the
 * router's RETURNS rather than its case labels.
 *
 * THE FIX IS NOT IN THIS MODULE'S REACH. `DESTINATION_RULES` lives in
 * `src/modules/notifications/domain/engine/notification-destination.ts`; the
 * two candidate repairs — re-point the two keys at a surface the parent app
 * opens, or open `progress` in the parent app — are a notifications-module
 * change and a Flutter change respectively. So this ledger reports rather than
 * repairs, and the `it.failing` below turns the day either lands into a red
 * build that forces the entry out.
 */
interface DeadDestinationEntry {
  readonly copyKey: string;
  /** Where the evidence is. `file:line`, so a reader can check the claim. */
  readonly evidence: string;
  readonly detail: string;
}

const DEAD_DESTINATION_LEDGER: readonly DeadDestinationEntry[] = Object.freeze([
  {
    copyKey: 'REWARD_GRANTED',
    evidence: 'apps/parent-app/lib/core/routing/deep_link_router.dart:212',
    detail:
      'The most-sent parent sentence in this product — «حصل {childName} على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.» — resolves to `abny://progress`, and `DeepLinkRouter.resolve` answers `progress` with `DeepLinkRoute.unavailable()` because `LearningProgressScreen` needs a `childId` AND a `childName` that the identifier-free payload will never carry (`e2e-13 STEP 14`). The sentence tells a parent to open the app and the tap lands them back on the inbox with a snackbar.',
  },
  {
    copyKey: 'BADGE_EARNED_PARENT',
    evidence: 'apps/parent-app/lib/core/routing/deep_link_router.dart:212',
    detail:
      'The same dead surface, one key over: «حصل {childName} على وسام {badgeTitle}. التفاصيل داخل التطبيق.» resolves to `abny://progress` and the parent app cannot open it. It is listed separately rather than folded into the entry above because the two keys are repaired independently — the badge sentence has a defensible landing the reward sentence does not, and one being fixed must not silence the other.',
  },
]);

// ===========================================================================
// 6. THE CLIENT HALF — read from the Flutter apps, never edited
// ===========================================================================

interface ClientRouting {
  readonly wireNames: readonly string[];
  readonly routedSurfaces: readonly string[];
  /** Surfaces whose case builds a route — a tap that lands somewhere. */
  readonly answeredSurfaces: readonly string[];
  /** Surfaces whose EVERY branch is `unavailable()` — a tap that dies. */
  readonly unansweredSurfaces: readonly string[];
}

/**
 * THE ROUTER, READ AS A ROUTER RATHER THAN AS A LIST OF LABELS.
 *
 * `routedSurfaces` — the old reading — is «does a `case` for this surface
 * exist», and it cannot tell a screen from a refusal: `progress` and `coach`
 * both have cases in `deep_link_router.dart` and both answer
 * `DeepLinkRoute.unavailable()`. So the RETURNS are read too.
 *
 * FALL-THROUGH IS THE WHOLE REASON THIS IS A SCAN AND NOT A REGEX. Dart's
 * `case a: case b: return X;` gives `a` no return of its own; the labels are
 * therefore accumulated until a segment actually returns, and the verdict is
 * applied to all of them — which is exactly how `progress` and `coach` share
 * one `unavailable()` in the parent app and how `screen-time` and
 * `notifications` share one `MyGrowthScreen` in the child app.
 *
 * A CASE IS ANSWERED IF ANY BRANCH BUILDS A ROUTE. `case goal: return id == null
 * ? unavailable() : page(...)` is answered, and correctly so: the server never
 * emits a bare id-bearing surface (`notification-destination.ts` degrades
 * `goal` to `goals` itself), so the branch a real link takes is the page.
 */
function readClientRouting(dir: string, routerFile: string): ClientRouting {
  const link = fs.readFileSync(path.join(dir, 'deep_link.dart'), 'utf8');
  const router = stripComments(fs.readFileSync(path.join(dir, routerFile), 'utf8'));
  const enumToWire = new Map<string, string>();
  for (const m of link.matchAll(/DeepLinkSurface\.([A-Za-z_]\w*)\s*=>\s*'([^']+)'/g)) {
    enumToWire.set(m[1], m[2]);
  }

  const labels = [...router.matchAll(/case\s+DeepLinkSurface\.([A-Za-z_]\w*)\s*:/g)];
  const routed = new Set<string>();
  const answered = new Set<string>();
  const unanswered = new Set<string>();
  let pending: string[] = [];

  for (let i = 0; i < labels.length; i += 1) {
    const wire = enumToWire.get(labels[i][1]);
    if (!wire) continue;
    routed.add(wire);
    pending.push(wire);

    const from = (labels[i].index as number) + labels[i][0].length;
    const to = i + 1 < labels.length ? (labels[i + 1].index as number) : router.length;
    const returns = [...router.slice(from, to).matchAll(/return\s+([\s\S]*?);/g)].map((m) => m[1]);
    if (returns.length === 0) continue; // falls through to the next label

    const dead = returns.every((expression) =>
      /^\s*(?:const\s+)?[A-Za-z_]\w*\.unavailable\s*\(\s*\)\s*$/.test(expression),
    );
    for (const surface of pending) (dead ? unanswered : answered).add(surface);
    pending = [];
  }

  return {
    wireNames: [...enumToWire.values()].sort(),
    routedSurfaces: [...routed].sort(),
    answeredSurfaces: [...answered].sort(),
    unansweredSurfaces: [...unanswered].sort(),
  };
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
const deadDestinationKeys = DEAD_DESTINATION_LEDGER.map((e) => e.copyKey);

/**
 * THE QUALITY AUDIT'S INPUT, ASSEMBLED FROM PRODUCTION ARTEFACTS AND NOTHING
 * ELSE. Every field is either an imported production table, a function this
 * suite did not write, or something read out of `src/` and the two Flutter
 * routers at test time. There is no list here for anybody to keep in step.
 */
const quality: KeyQualityInput = {
  keys: producibleKeys,
  catalogue: COPY_CATALOGUE as unknown as Readonly<Record<string, QualityCatalogueEntry>>,
  classes: NOTIFICATION_CLASSES as unknown as Readonly<Record<string, QualityClassEntry>>,
  selectableUnder: producibility.copyKeyTypes,
  producedBy: producibility.copyKeySites,
  destinationOf: (key, audience) =>
    hasExplicitDestination(key)
      ? resolveNotificationDestination({ copyKey: key, audience: audience as 'PARENT' | 'CHILD' })
      : null,
  answeredSurfaces: {
    PARENT: parentRouting.answeredSurfaces,
    CHILD: childRouting.answeredSurfaces,
  },
  causalKeyComposers: causalKeyComposers(files),
};

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

    it('every classification carries a class from its OWN closed vocabulary and a real one-line reason', () => {
      // TWO VOCABULARIES, because they answer two questions: a KEY is classified
      // when it legitimately has no producer; a DOOR is classified when its
      // event type cannot be resolved. Sharing one word list let a door reason
      // stand in for a key reason, which is the thing this file exists to stop.
      for (const entry of CLASSIFIED_COPY_KEYS) {
        expect(KEY_CLASSIFICATIONS).toContain(entry.classification);
      }
      for (const entry of CLASSIFIED_DOORS) {
        expect(DOOR_CLASSIFICATIONS).toContain(entry.classification);
      }
      for (const entry of [...CLASSIFIED_COPY_KEYS, ...CLASSIFIED_DOORS]) {
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
  // RULES P8..P12 — WHAT A KEY MUST CARRY BESIDES A PRODUCER
  //
  // The set under audit is `producibleKeys`, which is DISCOVERED by RULE P1's
  // own analysis. So a key added tomorrow is audited tomorrow, and a key that
  // stops being producible stops being audited HERE and starts failing THERE.
  // =========================================================================
  describe('RULES P8..P12 — a producible key is not a shippable key', () => {
    it('the set under audit is the producible set, and it is not empty', () => {
      expect(producibleKeys.length).toBeGreaterThanOrEqual(25);
      expect(quality.keys).toEqual(producibleKeys);
      // And the artefacts really were read, rather than defaulting to empty —
      // an audit over three empty tables passes every check it has.
      expect(Object.keys(quality.catalogue).length).toBe(copyKeys().length);
      expect(Object.keys(quality.classes).length).toBeGreaterThanOrEqual(25);
      expect(quality.causalKeyComposers).toEqual(
        expect.arrayContaining(['forDomainEvent', 'forEntity', 'forRecurringSignal']),
      );
      expect(quality.answeredSurfaces.PARENT.length).toBeGreaterThan(0);
      expect(quality.answeredSurfaces.CHILD.length).toBeGreaterThan(0);
    });

    it('RULE P8 — every producible key declares an audience, and the two tables agree about it', () => {
      expect(keysWithoutDeclaredAudience(quality)).toEqual([]);
    });

    it('RULE P9 — every producible key has Arabic copy, present, non-empty and actually Arabic', () => {
      expect(keysWithoutArabicCopy(quality)).toEqual([]);
    });

    it('RULE P10 — every producible key resolves to a WRITTEN quiet-hours class, never the default', () => {
      expect(keysWithoutSafetyClassification(quality)).toEqual([]);
    });

    it('RULE P12 — every producible key names a producer that COMPOSES its causal key', () => {
      expect(keysWithoutProvenance(quality)).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // RULE P11 — the destination, and the ledger of the taps that die
    // -----------------------------------------------------------------------
    describe('RULE P11 — the tap lands on a screen the reader’s own app can open', () => {
      it('the ONLY dead destinations are the ones on the ledger — a new one fails here BY NAME', () => {
        const dead = keysWithDeadDestination(quality)
          .map((finding) => finding.split(' — ')[0])
          .sort();
        expect(dead).toEqual([...deadDestinationKeys].sort());
      });

      it('the ledger names a real key, a real evidence file and says what is wrong', () => {
        for (const entry of DEAD_DESTINATION_LEDGER) {
          expect(copyKeys()).toContain(entry.copyKey);
          expect(producibleKeys).toContain(entry.copyKey);
          expect(`${entry.copyKey}:${entry.detail.trim().length > 60}`).toBe(`${entry.copyKey}:true`);
          expect(entry.evidence).toMatch(/^apps\/(parent|child)-app\//);
          expect(fs.existsSync(path.join(REPO_ROOT, entry.evidence.split(':')[0]))).toBe(true);
        }
        expect(deadDestinationKeys).toHaveLength(new Set(deadDestinationKeys).size);
      });

      /**
       * THE RATCHET, and it is `PRODUCERLESS_DEFECT_LEDGER`'s idiom because it is
       * the same contract: `it.failing` PASSES while the body throws and FAILS
       * the day it stops. So every dead tap is named in every run's report, and
       * fixing one breaks the build until its entry is deleted. Both branches
       * assert, for the reason the producerless ledger's own branch does —
       * `jest-each` refuses an empty table, so «no dead taps» must be a stated
       * outcome rather than an absent block.
       */
      if (DEAD_DESTINATION_LEDGER.length === 0) {
        it('is EMPTY — every producible key lands on a screen its own app can open', () => {
          expect(keysWithDeadDestination(quality)).toEqual([]);
          expect(parentRouting.unansweredSurfaces).toEqual([]);
        });
      } else {
        it.failing.each(DEAD_DESTINATION_LEDGER.map((e) => [e.copyKey, e.detail]))(
          '%s lands on a screen its own app can OPEN',
          (copyKey) => {
            expect(keysWithDeadDestination(quality).map((f) => f.split(' — ')[0])).not.toContain(copyKey);
          },
        );
      }

      it('the two surfaces the parent app refuses are READ from its router, not assumed', () => {
        // Named, because the ledger above stands on them: if `progress` gains a
        // screen this goes red beside the `it.failing`, and the two together say
        // what happened rather than leaving one silent.
        expect(parentRouting.unansweredSurfaces).toEqual(['coach', 'progress']);
        expect(childRouting.unansweredSurfaces).toEqual([]);
        // And ANSWERED + UNANSWERED partition the routed set: a surface the
        // scan failed to attribute would otherwise vanish from both.
        expect([...parentRouting.answeredSurfaces, ...parentRouting.unansweredSurfaces].sort()).toEqual(
          parentRouting.routedSurfaces,
        );
        expect([...childRouting.answeredSurfaces, ...childRouting.unansweredSurfaces].sort()).toEqual(
          childRouting.routedSurfaces,
        );
      });
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

    // =======================================================================
    // THE NEGATIVE CONTROLS FOR RULES P8..P12.
    //
    // ONE SYNTHETIC KEY, MADE COMPLETE, AND THEN BROKEN ONE PROPERTY AT A TIME.
    // Each control asserts BOTH directions: the broken fixture is reported BY
    // NAME, and the repaired one clears. A control that only checked the
    // failing direction would pass for an analyser that reports everything, and
    // one that only checked the passing direction would pass for an analyser
    // that reports nothing — and this file has caught both shapes before.
    // =======================================================================
    describe('RULES P8..P12 — each new check provably discriminates', () => {
      const AR = { title: 'عنوان', body: 'نص عربي حقيقي' };
      const EN = { title: 'Title', body: 'An English body' };

      const site = (over: Partial<DoorSite> = {}): DoorSite => ({
        file: 'src/modules/x/x.service.ts',
        line: 12,
        method: 'handleEvent',
        kind: 'ENGINE',
        raw: "'WIDGET_EARNED'",
        types: ['WIDGET_EARNED'],
        how: 'LITERAL',
        slots: ['familyId', 'eventType', 'sourceEventId', 'trigger'],
        sourceExpression: 'forDomainEvent(envelope.id)',
        resolved: true,
        ...over,
      });

      /** A key with everything RULE P8..P12 demands. Every control below is
       * this, minus one property. */
      const complete = (over: Partial<KeyQualityInput> = {}): KeyQualityInput => ({
        keys: ['WIDGET_EARNED'],
        catalogue: {
          WIDGET_EARNED: {
            category: 'REWARD',
            audience: 'PARENT',
            variants: { PARENT: { ar: AR, en: EN } },
          },
        },
        classes: {
          WIDGET_EARNED: {
            quietHours: 'DEFER',
            audience: 'PARENT',
            category: 'REWARD',
            why: 'A widget is a durable fact about the household and it survives the night, so it is held until the window ends rather than dropped.',
          },
        },
        selectableUnder: new Map([['WIDGET_EARNED', ['WIDGET_EARNED']]]),
        producedBy: new Map([['WIDGET_EARNED', [site()]]]),
        destinationOf: () => 'abny://rewards',
        answeredSurfaces: { PARENT: ['rewards', 'notifications'], CHILD: ['rewards', 'notifications'] },
        causalKeyComposers: ['forDomainEvent', 'forEntity'],
        ...over,
      });

      it('the COMPLETE fixture passes all five — the controls below are measuring a difference', () => {
        const input = complete();
        expect(keysWithoutDeclaredAudience(input)).toEqual([]);
        expect(keysWithoutArabicCopy(input)).toEqual([]);
        expect(keysWithoutSafetyClassification(input)).toEqual([]);
        expect(keysWithDeadDestination(input)).toEqual([]);
        expect(keysWithoutProvenance(input)).toEqual([]);
      });

      // -- P8 ---------------------------------------------------------------
      it('P8: a key with NO declared audience is reported by name, and declaring one clears it', () => {
        const broken = complete({
          catalogue: { WIDGET_EARNED: { category: 'REWARD', audience: '', variants: { PARENT: { ar: AR } } } },
        });
        expect(keysWithoutDeclaredAudience(broken).join('\n')).toContain('WIDGET_EARNED');
        expect(keysWithoutDeclaredAudience(complete())).toEqual([]);
      });

      it('P8: a catalogue audience that CONTRADICTS the class matrix is reported', () => {
        const contradiction = complete({
          classes: {
            WIDGET_EARNED: {
              quietHours: 'DEFER',
              audience: 'CHILD',
              category: 'REWARD',
              why: 'A widget is a durable fact about the household and it survives the night, so it is held until the window ends rather than dropped.',
            },
          },
        });
        expect(keysWithoutDeclaredAudience(contradiction).join('\n')).toMatch(
          /WIDGET_EARNED.*PARENT.*CHILD/,
        );
        // …and `BOTH` is NOT a contradiction: it is the class matrix saying the
        // producer composes two single-audience candidates.
        const both = complete({
          classes: {
            WIDGET_EARNED: {
              quietHours: 'DEFER',
              audience: 'BOTH',
              category: 'REWARD',
              why: 'A widget is a durable fact about the household and it survives the night, so it is held until the window ends rather than dropped.',
            },
          },
        });
        expect(keysWithoutDeclaredAudience(both)).toEqual([]);
      });

      // -- P9 ---------------------------------------------------------------
      it('P9: a key MISSING its Arabic template is reported by name, and adding it clears the report', () => {
        const missing = complete({
          catalogue: {
            WIDGET_EARNED: { category: 'REWARD', audience: 'PARENT', variants: { PARENT: { en: EN } } },
          },
        });
        expect(keysWithoutArabicCopy(missing).join('\n')).toContain("WIDGET_EARNED/PARENT — no 'ar' template");
        expect(keysWithoutArabicCopy(complete())).toEqual([]);
      });

      it('P9: an EMPTY Arabic body, and an ENGLISH sentence parked in the `ar` slot, are both reported', () => {
        const empty = complete({
          catalogue: {
            WIDGET_EARNED: {
              category: 'REWARD',
              audience: 'PARENT',
              variants: { PARENT: { ar: { title: 'عنوان', body: '   ' } } },
            },
          },
        });
        expect(keysWithoutArabicCopy(empty).join('\n')).toContain('the Arabic body is empty');

        const english = complete({
          catalogue: {
            WIDGET_EARNED: {
              category: 'REWARD',
              audience: 'PARENT',
              variants: { PARENT: { ar: { title: 'عنوان', body: 'You earned a new reward' } } },
            },
          },
        });
        expect(keysWithoutArabicCopy(english).join('\n')).toContain('contains no Arabic letter');
      });

      it('P9: a CHILD key that skips a tone band is reported — the fallback walk hides it otherwise', () => {
        const partial = complete({
          catalogue: {
            WIDGET_EARNED: {
              category: 'REWARD',
              audience: 'CHILD',
              variants: { '5-7': { ar: AR }, '8-10': { ar: AR }, '11-13': { ar: AR } },
            },
          },
        });
        expect(keysWithoutArabicCopy(partial).join('\n')).toContain("no '14-17' variant");

        const full = complete({
          catalogue: {
            WIDGET_EARNED: {
              category: 'REWARD',
              audience: 'CHILD',
              variants: {
                '5-7': { ar: AR },
                '8-10': { ar: AR },
                '11-13': { ar: AR },
                '14-17': { ar: AR },
              },
            },
          },
        });
        expect(keysWithoutArabicCopy(full)).toEqual([]);
      });

      // -- P10 --------------------------------------------------------------
      it('P10: a key with no quiet-hours row anywhere is reported, and classifying it clears the report', () => {
        const unclassified = complete({ classes: {} });
        expect(keysWithoutSafetyClassification(unclassified).join('\n')).toContain(
          'DEFAULT_QUIET_HOURS_CLASS',
        );
        expect(keysWithoutSafetyClassification(complete())).toEqual([]);
      });

      it('P10: a CONTEXTUAL key inherits the class of the type it is selected under', () => {
        // The shape of `GOAL_ALMOST_DONE`: a sentence, not a type, with no row
        // of its own — classified when its producing type is, and reported when
        // its producing type is not.
        const shared = {
          catalogue: {
            WIDGET_NEARLY: { category: 'REWARD', audience: 'PARENT', variants: { PARENT: { ar: AR } } },
          },
          keys: ['WIDGET_NEARLY'],
          producedBy: new Map([['WIDGET_NEARLY', [site()]]]),
        };
        const viaClassifiedType = complete({
          ...shared,
          selectableUnder: new Map([['WIDGET_NEARLY', ['WIDGET_EARNED']]]),
        });
        expect(keysWithoutSafetyClassification(viaClassifiedType)).toEqual([]);

        const viaUnclassifiedType = complete({
          ...shared,
          selectableUnder: new Map([['WIDGET_NEARLY', ['WIDGET_SOMETHING_ELSE']]]),
        });
        expect(keysWithoutSafetyClassification(viaUnclassifiedType).join('\n')).toContain(
          'WIDGET_SOMETHING_ELSE',
        );
      });

      it('P10: a class row whose `why` says nothing is not a classification', () => {
        const unreasoned = complete({
          classes: {
            WIDGET_EARNED: { quietHours: 'DELIVER', audience: 'PARENT', category: 'REWARD', why: 'because' },
          },
        });
        expect(keysWithoutSafetyClassification(unreasoned).join('\n')).toContain('WIDGET_EARNED');
      });

      // -- P11 --------------------------------------------------------------
      it('P11: a destination the app answers with NO SCREEN is reported by name, and opening it clears the report', () => {
        // THE `CHILD_WELLBEING_CHECKIN` SHAPE, reproduced: the surface is real,
        // the link is well-formed, the router has a case for it — and the case
        // returns `unavailable()`. This is the exact control that would have
        // caught the shipped defect.
        const dead = complete({ destinationOf: () => 'abny://coach' });
        expect(keysWithDeadDestination(dead).join('\n')).toContain(
          'WIDGET_EARNED — resolves to abny://coach',
        );

        const opened = complete({
          destinationOf: () => 'abny://coach',
          answeredSurfaces: { PARENT: ['coach', 'rewards', 'notifications'], CHILD: ['rewards'] },
        });
        expect(keysWithDeadDestination(opened)).toEqual([]);
      });

      it('P11: a key with NO explicit destination rule at all is reported', () => {
        expect(keysWithDeadDestination(complete({ destinationOf: () => null })).join('\n')).toContain(
          'no explicit destination rule',
        );
      });

      it('P11: the check is PER AUDIENCE — a surface only the parent app opens is dead for a child', () => {
        const childKey = complete({
          catalogue: {
            WIDGET_EARNED: {
              category: 'REWARD',
              audience: 'CHILD',
              variants: {
                '5-7': { ar: AR },
                '8-10': { ar: AR },
                '11-13': { ar: AR },
                '14-17': { ar: AR },
              },
            },
          },
          destinationOf: () => 'abny://subscription',
          answeredSurfaces: { PARENT: ['subscription'], CHILD: ['rewards', 'notifications'] },
        });
        expect(keysWithDeadDestination(childKey).join('\n')).toContain('the CHILD app answers');
      });

      it('P11: the router scan reads RETURNS, so a fall-through case inherits the verdict below it', () => {
        // `case a: case b: return unavailable();` — the shape `progress` and
        // `coach` share in `deep_link_router.dart`. A scan that stopped at the
        // labels would call `a` routed and say nothing about whether it opens.
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'abny-router-'));
        fs.writeFileSync(
          path.join(dir, 'deep_link.dart'),
          `String wire(DeepLinkSurface s) => switch (s) {
             DeepLinkSurface.alpha => 'alpha',
             DeepLinkSurface.beta => 'beta',
             DeepLinkSurface.gamma => 'gamma',
           };`,
        );
        fs.writeFileSync(
          path.join(dir, 'router.dart'),
          `static Route resolve(d) {
             switch (d.surface) {
               case DeepLinkSurface.alpha:
                 return Route.named(AppRoutes.alpha);
               // a comment that says the word return, and must not be counted
               case DeepLinkSurface.beta:
               case DeepLinkSurface.gamma:
                 return Route.unavailable();
             }
           }`,
        );
        const routing = readClientRouting(dir, 'router.dart');
        expect(routing.routedSurfaces).toEqual(['alpha', 'beta', 'gamma']);
        expect(routing.answeredSurfaces).toEqual(['alpha']);
        expect(routing.unansweredSurfaces).toEqual(['beta', 'gamma']);
        fs.rmSync(dir, { recursive: true, force: true });
      });

      // -- P12 --------------------------------------------------------------
      it('P12: a producer that INVENTS its causal key is reported, and composing it clears the report', () => {
        const invented = complete({
          producedBy: new Map([['WIDGET_EARNED', [site({ sourceExpression: '`evt:${childId}:widget`' })]]]),
        });
        expect(keysWithoutProvenance(invented).join('\n')).toContain('invents its causal key in place');
        expect(keysWithoutProvenance(complete())).toEqual([]);
      });

      it('P12: a producer that states NO causal key at all is reported', () => {
        const silent = complete({
          producedBy: new Map([['WIDGET_EARNED', [site({ sourceExpression: null })]]]),
        });
        expect(keysWithoutProvenance(silent).join('\n')).toContain('states no sourceEventId');
      });

      it('P12: an UNDOCUMENTED composer is reported, and a RELAY of an upstream key is not', () => {
        const homeGrown = complete({
          producedBy: new Map([['WIDGET_EARNED', [site({ sourceExpression: 'myOwnKey(childId)' })]]]),
        });
        expect(keysWithoutProvenance(homeGrown).join('\n')).toContain("composes its causal key with 'myOwnKey'");

        // `BillingNotificationProducer.tell`'s shape: the key was composed by
        // the caller and is relayed here. That is provenance, not its absence.
        const relay = complete({
          producedBy: new Map([['WIDGET_EARNED', [site({ sourceExpression: 'input.sourceEventId' })]]]),
        });
        expect(keysWithoutProvenance(relay)).toEqual([]);
      });

      it('P12: a key nothing produces is reported rather than quietly passing', () => {
        expect(keysWithoutProvenance(complete({ producedBy: new Map() })).join('\n')).toContain(
          'no door site names it',
        );
      });

      it('the multi-line causal key a real producer writes is read whole', () => {
        // `goal-nudge.service.ts` composes `forEntity(...)` over four lines, and
        // a line-bounded read would see `forEntity(` and report an invention.
        const literal = `{
          familyId,
          eventType: 'WIDGET_EARNED',
          sourceEventId: forEntity(
            'signal',
            childId,
            programId,
            businessDate,
          ),
          trigger: 'DOMAIN_EVENT',
        }`;
        expect(objectProperty(literal, 'sourceEventId')?.startsWith('forEntity(')).toBe(true);
        expect(objectProperty(literal, 'sourceEventId')).toContain('businessDate');
        expect(objectProperty(literal, 'trigger')).toBe("'DOMAIN_EVENT'");
        // Shorthand is a relay of a value composed elsewhere, and reads as one.
        expect(objectProperty('{ familyId, sourceEventId }', 'sourceEventId')).toBe('sourceEventId');
        expect(objectProperty('{ familyId }', 'sourceEventId')).toBeNull();
      });
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
