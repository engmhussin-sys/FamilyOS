import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../../../pairing/application/ports/runtime-alert.repository.port';
import { forRecurringSignal } from '../../../../shared/notifications/notification-source-key';
import { ChildrenService } from '../../../children/application/services/children.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import {
  DISTRESS_MEMORY_CATEGORY,
  DISTRESS_RESPONSE_CARD,
  classifyDistress,
  distressParentAlert,
  type DistressCode,
  type DistressResponseCard,
} from '../../domain/distress';
import { AI_MEMORY_REPOSITORY, type IAiMemoryRepository } from '../../domain/memory.types';

export interface DistressCheckinResult {
  /** True ⇒ the child sees `card`; the normal encouragement flow is FROZEN for
   * this child in this run (§11.4). */
  readonly escalated: boolean;
  readonly card: DistressResponseCard | null;
  /** Present only when escalated. The classification code — never the text. */
  readonly code: DistressCode | null;
  /** Whether the parent alert was written. `false` means an identical alert
   * already existed inside the dedupe window, which is a success, not a
   * failure — see `PrismaRuntimeAlertRepository.createForFamilyOwner`. */
  readonly parentAlerted: boolean;
}

/**
 * B8 — THE DISTRESS ESCALATION PATH.
 *
 * §11.4 in code. Read the constructor: there is a memory repository, a runtime
 * alert PORT, a children service and a date service. **There is no
 * `AI_PROVIDER` in this class, and that absence is the design.** The one
 * situation in this product where a child's own words matter most is the one
 * situation where no model is consulted, because a model asked to respond to a
 * child in distress will improvise, and improvisation is precisely what §11.4
 * forbids.
 *
 * THE FIVE PROPERTIES, EACH TESTED:
 *
 *   1. NO PROVIDER CALL, EVER. `distress-escalation.spec.ts` injects a
 *      counting provider into the whole module and asserts zero calls across
 *      every distress code and every non-distress input.
 *   2. THE RAW TEXT NEVER LEAVES THIS METHOD. `classifyDistress` takes a
 *      string and returns a code; the string is not stored, not logged, not
 *      returned, and not placed in the alert. What is written to
 *      `ai_memory_entries` is `{ code, detectedAt }` and nothing else.
 *   3. THE CHILD SEES A FIXED, HUMAN-WRITTEN CARD. `DISTRESS_RESPONSE_CARD` is
 *      a frozen constant. It is not a template a model fills in, and it is
 *      identical for every code — telling a child how serious we judged their
 *      words to be is the diagnosis §11.4 forbids.
 *   4. THE PARENT ALERT QUOTES NOTHING. «قد يحتاج {name} لحديث معك اليوم»,
 *      CRITICAL priority so it outranks quiet hours, and no detail.
 *   5. IT WRITES THROUGH THE ONE NOTIFICATION WRITER. `ai-core` does not touch
 *      `notifications` itself — it calls `RUNTIME_ALERT_REPOSITORY`, the single
 *      writer B9 established, which owns dedupe, the `(family_id,
 *      source_event_id, user_id)` constraint and the push. The AI's two
 *      writable tables stay two.
 *
 * RECALL OVER PRECISION, DELIBERATELY (§11.4). The keyword list will fire on
 * ordinary teenage hyperbole. The cost of that is one gentle parent
 * notification; the cost of the opposite error is not one this project is
 * willing to price.
 *
 * NOT A CRISIS SERVICE. It does not diagnose, does not advise medically, does
 * not promise confidentiality, and does not replace professional care. The
 * helpline directory is a PLACEHOLDER pending per-market clinical review — an
 * explicit launch gate (§13 R-8), and it is restated in `distress.ts` beside
 * the numbers themselves so nobody ships them by accident.
 */
@Injectable()
export class DistressEscalationService {
  private readonly logger = new Logger(DistressEscalationService.name);

  constructor(
    @Inject(AI_MEMORY_REPOSITORY) private readonly memory: IAiMemoryRepository,
    @Inject(RUNTIME_ALERT_REPOSITORY) private readonly alerts: IRuntimeAlertRepository,
    private readonly children: ChildrenService,
    private readonly familyDate: FamilyDateService,
  ) {}

  async checkin(
    childId: string,
    familyId: string,
    freeText: string,
    now: Date = new Date(),
  ): Promise<DistressCheckinResult> {
    const child = await this.children.getChildOrThrow(childId, familyId);
    const verdict = classifyDistress(freeText);

    if (!verdict.detected) {
      return { escalated: false, card: null, code: null, parentAlerted: false };
    }

    // The business date is the family's, not UTC's — a check-in at 00:30 in
    // Riyadh belongs to that family's night, and the alert's dedupe window
    // should agree with the calendar the rest of this product uses (B8 task 8).
    const businessDate = await this.familyDate.getBusinessDate(familyId, now);

    // CODE AND TIME ONLY. Note what is not in this object: `freeText`, any
    // substring of it, any length of it, and any hash of it.
    await this.memory.record(childId, DISTRESS_MEMORY_CATEGORY, {
      code: verdict.code,
      businessDate,
      detectedAt: now.toISOString(),
    });

    const alert = distressParentAlert(child.firstName);
    const parentAlerted = await this.alerts.createForFamilyOwner({
      familyId,
      childId,
      title: alert.title,
      body: alert.body,
      type: 'CHILD_WELLBEING_CHECKIN',
      // CRITICAL so it outranks quiet hours (§11.4: «يتجاوز quiet hours»).
      priority: 'CRITICAL',
      // The recurring form: this condition legitimately recurs and SHOULD alert
      // again later, but not twice inside one window. The discriminator is the
      // business DATE, not the code — a second signal the same day is the same
      // conversation, and telling a parent twice in one evening adds pressure
      // without adding information.
      sourceEventId: forRecurringSignal('signal', childId, `distress:${businessDate}`, now),
      // Deliberately no `data` payload: a JSON blob is where a raw quote ends
      // up when someone adds "context" to an alert six months from now.
    });

    // Metrics only. The code, never the text — and never the child's full id.
    this.logger.warn(
      JSON.stringify({
        event: 'child_distress_signal',
        code: verdict.code,
        childRef: childId.slice(0, 8),
        parentAlerted,
      }),
    );

    return { escalated: true, card: DISTRESS_RESPONSE_CARD, code: verdict.code, parentAlerted };
  }
}
