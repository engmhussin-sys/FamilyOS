import * as fs from 'fs';
import * as path from 'path';

import {
  SAFETY_TRANSITIONS,
  findTransition,
  isOpen,
} from '../../src/modules/safety/domain/safety-review';
import { ROLE_PERMISSIONS } from '../../src/common/authz/permissions';
import type { AiAlertStatus } from '../../src/modules/ai-core/domain/ai-alert.types';

/**
 * ===========================================================================
 * THE REVIEW WORKFLOW THAT DID NOT EXIST — proven as a workflow.
 * ===========================================================================
 *
 * `AlertStatus` has had four values since the table was created and exactly one
 * was reachable: `PrismaAiAlertRepository` pins it (`_statusIsExhaustive:
 * AlertStatus = 'NEW'`), `reviewed_at` had no writer anywhere in `src/`, and no
 * operator route read the table. Every distress signal this product has raised
 * is unreviewed, and a growth alarm counting unreviewed criticals could only
 * ever climb because nothing could clear one.
 *
 * So the tests that matter are of two kinds: the transition table is a value
 * with assertable properties, and — more importantly — a RATCHET that goes
 * looking through `src/` for the writers, because the whole defect was an
 * absence that nothing failed on.
 */

const ROOT = path.resolve(__dirname, '../..');
const ALL_STATUSES: AiAlertStatus[] = ['NEW', 'REVIEWED', 'DISMISSED', 'ESCALATED'];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

describe('the safety review workflow', () => {
  describe('the transition table', () => {
    it('makes every status reachable — three of the four never were', () => {
      const reachable = new Set(SAFETY_TRANSITIONS.map((rule) => rule.to));
      for (const status of ALL_STATUSES) {
        expect(reachable.has(status)).toBe(true);
      }
    });

    it('has no move that changes nothing', () => {
      // A NEW -> NEW rule would let a "review" be recorded that reviewed
      // nothing, with an audit row saying somebody acted.
      expect(SAFETY_TRANSITIONS.filter((rule) => rule.from === rule.to)).toEqual([]);
    });

    it('lets nothing reach NEW except a deliberate reopen', () => {
      const intoNew = SAFETY_TRANSITIONS.filter((rule) => rule.to === 'NEW');
      expect(intoNew.map((rule) => rule.from).sort()).toEqual(['DISMISSED', 'REVIEWED']);
      // In particular NOT from ESCALATED: "we escalated this and then pretended
      // nobody had seen it" is not a state this product offers.
      expect(findTransition('ESCALATED', 'NEW')).toBeNull();
    });

    it('puts escalation behind its own permission, everywhere', () => {
      for (const rule of SAFETY_TRANSITIONS) {
        expect(rule.permission).toBe(rule.to === 'ESCALATED' ? 'safety.escalate' : 'safety.review');
      }
    });

    it('lets new information escalate an alert somebody already closed', () => {
      // The moment escalation matters most is after a premature dismissal.
      expect(findTransition('DISMISSED', 'ESCALATED')).not.toBeNull();
      expect(findTransition('REVIEWED', 'ESCALATED')).not.toBeNull();
    });

    it('counts ESCALATED as still open — an escalation nobody returns to is the failure mode', () => {
      expect(isOpen('NEW')).toBe(true);
      expect(isOpen('ESCALATED')).toBe(true);
      expect(isOpen('REVIEWED')).toBe(false);
      expect(isOpen('DISMISSED')).toBe(false);
    });

    it('offers no removal of any kind', () => {
      // No archived state, no deleted state, no move that takes an alert out of
      // the record. The directive is categorical on this.
      const vocabulary = new Set<string>([...ALL_STATUSES]);
      for (const rule of SAFETY_TRANSITIONS) {
        expect(vocabulary.has(rule.from)).toBe(true);
        expect(vocabulary.has(rule.to)).toBe(true);
      }
    });
  });

  describe('the writers exist — the property that was missing for the life of the product', () => {
    const sources = [...walk(path.join(ROOT, 'src'))].map((file) => ({
      file: path.relative(ROOT, file),
      text: fs.readFileSync(file, 'utf8'),
    }));

    it('something in src/ actually writes reviewed_at and the reviewer', () => {
      const writers = sources.filter((s) => /reviewed_by_operator_id\s*=/.test(s.text));
      expect(writers.map((s) => s.file)).toEqual([
        path.join('src', 'modules', 'safety', 'application', 'services', 'safety-review.service.ts'),
      ]);
    });

    it('reopening CLEARS the reviewer, so the unreviewed-critical alarm is honest in both directions', () => {
      const service = sources.find((s) => s.file.endsWith('safety-review.service.ts'));
      // The growth alarm counts `reviewedAt: null` criticals. If a reopen left
      // a stale reviewer stamped, that alarm would under-report the real
      // backlog — the mirror image of the defect being fixed here.
      expect(service?.text).toContain('reopening');
      expect(service?.text).toMatch(/reopening \? null : now/);
    });

    it('the QUEUE query selects no title and no description', () => {
      const service = sources.find((s) => s.file.endsWith('safety-review.service.ts'));
      const queue = service!.text.slice(
        service!.text.indexOf('async listQueue'),
        service!.text.indexOf('async readAlert'),
      );
      // The safest way not to disclose a field is not to read it — the same
      // discipline household-detail applies to a child's date of birth.
      expect(queue).not.toMatch(/\ba\.title\b/);
      expect(queue).not.toMatch(/\ba\.description\b/);
    });

    it('every read of alert CONTENT writes an audit row', () => {
      const service = sources.find((s) => s.file.endsWith('safety-review.service.ts'));
      const read = service!.text.slice(service!.text.indexOf('async readAlert'));
      expect(read).toContain("action: 'safety.alert_content_read'");
      // Written BEFORE the content is returned: a description that reached a
      // human with no record of it reaching them is what the requirement forbids.
      expect(read.indexOf('safety.alert_content_read')).toBeLessThan(read.indexOf('return {'));
    });

    it('NOTHING anywhere deletes an alert or a note', () => {
      const offenders = sources.filter(
        (s) =>
          /aiAlert\.delete|aiAlertNote\.(delete|update)|DELETE FROM ai_alerts|DELETE FROM ai_alert_notes/.test(
            s.text,
          ),
      );
      expect(offenders.map((s) => s.file)).toEqual([]);
    });
  });

  describe('the permission line, restated where the workflow lives', () => {
    it('gives no role a review power without the content it acts on', () => {
      for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        if (permissions.includes('safety.review') || permissions.includes('safety.escalate')) {
          expect(permissions).toContain('safety.read_content');
          expect(role).not.toBe('SUPPORT');
        }
      }
    });
  });
});
