import { Test } from '@nestjs/testing';

import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { AI_MEMORY_REPOSITORY } from '../../src/modules/ai-core/domain/memory.types';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { DistressEscalationService } from '../../src/modules/ai-core/application/services/distress-escalation.service';
import {
  DISTRESS_RESPONSE_CARD,
  classifyDistress,
  distressParentAlert,
} from '../../src/modules/ai-core/domain/distress';

/**
 * B8 — THE DISTRESS PATH (§11.4).
 *
 * «المبدأ الحاكم: الموديل لا يرتجل في هذه الحالة إطلاقًا.» Everything below is
 * a test of that one sentence:
 *   - zero provider calls, on every input, in both directions;
 *   - the child's text stored nowhere, echoed nowhere, sent nowhere;
 *   - a FIXED human-written card, identical for every severity;
 *   - a generically-worded CRITICAL parent alert that quotes nothing;
 *   - the family's own business date, not UTC's.
 *
 * SENSITIVITY IS TUNED FOR RECALL AND THE TESTS SAY SO. Some of the phrases
 * below are ordinary teenage hyperbole and this product escalates them anyway.
 * That is the stated trade in §11.4, and it is tested rather than merely
 * written down, so a future "reduce false positives" change has to argue with
 * a failing test.
 */

describe('classifyDistress — deterministic, offline, returns a CODE and never the text', () => {
  const SELF_HARM = [
    'أريد أن أموت',
    'عايز اموت',
    'لا أريد أن أعيش',
    'أؤذي نفسي كل يوم',
    'I want to die',
    'I want to hurt myself',
    'thinking about suicide',
  ];
  const ABUSE = ['أبي يضربني', 'خائف من الرجوع للبيت', 'he hits me', 'afraid to go home'];
  const HOPELESS = ['لا أحد يهتم', 'أكره نفسي', 'nobody cares', 'I hate my life'];
  const BULLYING = ['يتنمرون علي في المدرسة', 'they make fun of me'];
  const SAD = ['حزين جدًا', 'أبكي كل ليلة', 'I am so lonely'];

  it.each(SELF_HARM)('classifies SELF_HARM: %s', (text) => {
    expect(classifyDistress(text)).toEqual({ detected: true, code: 'SELF_HARM' });
  });

  it.each(ABUSE)('classifies ABUSE_OR_FEAR: %s', (text) => {
    expect(classifyDistress(text)).toEqual({ detected: true, code: 'ABUSE_OR_FEAR' });
  });

  it.each(HOPELESS)('classifies HOPELESSNESS: %s', (text) => {
    expect(classifyDistress(text)).toEqual({ detected: true, code: 'HOPELESSNESS' });
  });

  it.each(BULLYING)('classifies BULLYING: %s', (text) => {
    expect(classifyDistress(text)).toEqual({ detected: true, code: 'BULLYING' });
  });

  it.each(SAD)('classifies SEVERE_SADNESS: %s', (text) => {
    expect(classifyDistress(text)).toEqual({ detected: true, code: 'SEVERE_SADNESS' });
  });

  it('returns the MOST SEVERE code when several match — order is not accidental', () => {
    expect(classifyDistress('أكره نفسي وأريد أن أموت')).toEqual({ detected: true, code: 'SELF_HARM' });
  });

  it.each([
    'اليوم كان جيدًا',
    'أنهيت واجبي وأنا سعيد',
    'ذاكرت رياضيات ساعتين',
    'today was a good day',
    'I finished my homework',
    '',
    '   ',
  ])('does not fire on ordinary text: "%s"', (text) => {
    expect(classifyDistress(text)).toEqual({ detected: false });
  });

  it('NEVER returns the text — the signature itself is the privacy control', () => {
    const result = classifyDistress('أريد أن أموت لأن اسمي يوسف');
    expect(Object.keys(result).sort()).toEqual(['code', 'detected']);
    expect(JSON.stringify(result)).not.toContain('يوسف');
  });
});

describe('the fixed response card is a constant, not a template', () => {
  it('is human-written, identical for every code, and offers a real next step', () => {
    expect(DISTRESS_RESPONSE_CARD.humanWritten).toBe(true);
    expect(DISTRESS_RESPONSE_CARD.bodyAr).toContain('شخص بالغ تثق به');
    expect(DISTRESS_RESPONSE_CARD.helplines.map((h) => h.country).sort()).toEqual(['EG', 'SA']);
  });

  it('does NOT diagnose, does NOT advise medically, and does NOT promise secrecy', () => {
    const text = `${DISTRESS_RESPONSE_CARD.titleAr} ${DISTRESS_RESPONSE_CARD.bodyAr}`;
    for (const forbidden of ['اكتئاب', 'مرض', 'دواء', 'طبيب نفسي', 'سرّنا', 'لن أخبر', 'بيني وبينك', 'تشخيص']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('is frozen — nothing can mutate what a child in distress is shown', () => {
    expect(Object.isFrozen(DISTRESS_RESPONSE_CARD)).toBe(true);
  });
});

describe('the parent alert quotes nothing and classifies nothing', () => {
  it('names the child, asks for a conversation, and says nothing else', () => {
    const alert = distressParentAlert('يوسف');
    expect(alert.body).toContain('يوسف');
    expect(alert.body).toContain('حديث معك اليوم');
    for (const forbidden of ['SELF_HARM', 'كتب', 'قال', 'ذكر أنه', 'اكتئاب', 'خطير']) {
      expect(`${alert.title} ${alert.body}`).not.toContain(forbidden);
    }
  });

  it('is identical for every code — the parent is not told our severity judgement', () => {
    // Same function, no code parameter. The absence of the parameter IS the
    // guarantee; this asserts the signature has not grown one.
    expect(distressParentAlert.length).toBe(1);
  });
});

describe('DistressEscalationService', () => {
  let service: DistressEscalationService;
  const memory = { record: jest.fn(), upsert: jest.fn(), find: jest.fn(), findAllByCategory: jest.fn(), countByCategorySince: jest.fn() };
  const alerts = { createForFamilyOwner: jest.fn(), listForUser: jest.fn() };
  const children = { getChildOrThrow: jest.fn() };
  const familyDate = { getBusinessDate: jest.fn() };
  const provider = { complete: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    children.getChildOrThrow.mockResolvedValue({ firstName: 'يوسف', dateOfBirth: new Date('2015-04-01') });
    familyDate.getBusinessDate.mockResolvedValue('2026-08-15');
    alerts.createForFamilyOwner.mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        DistressEscalationService,
        { provide: AI_MEMORY_REPOSITORY, useValue: memory },
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: alerts },
        { provide: ChildrenService, useValue: children },
        { provide: FamilyDateService, useValue: familyDate },
        // Present in the module ONLY so that a future edit adding a provider
        // dependency would compile — and the assertion below would then fail,
        // which is the point.
        { provide: AI_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = moduleRef.get(DistressEscalationService);
  });

  const SECRET = 'أشعر أني أريد أن أموت ولا أحد يعرف';

  it('escalates, shows the fixed card, and NEVER calls a provider', async () => {
    const result = await service.checkin('c1', 'f1', SECRET);

    expect(result.escalated).toBe(true);
    expect(result.code).toBe('SELF_HARM');
    expect(result.card).toBe(DISTRESS_RESPONSE_CARD);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('stores the CODE and the TIME, and stores the text in no field of the record', async () => {
    await service.checkin('c1', 'f1', SECRET);

    expect(memory.record).toHaveBeenCalledTimes(1);
    const [childId, category, value] = memory.record.mock.calls[0];
    expect(childId).toBe('c1');
    expect(category).toBe('DISTRESS_SIGNAL');
    expect(value.code).toBe('SELF_HARM');
    expect(value.businessDate).toBe('2026-08-15');
    // THE PRIVACY ASSERTION.
    expect(JSON.stringify(value)).not.toContain('أموت');
    expect(JSON.stringify(value)).not.toContain(SECRET);
    // `upsert` would collapse repeated signals into one row and erase the
    // history a review queue needs — `record` is the correct verb.
    expect(memory.upsert).not.toHaveBeenCalled();
  });

  it('raises a CRITICAL parent alert through the ONE notification writer, quoting nothing', async () => {
    await service.checkin('c1', 'f1', SECRET);

    expect(alerts.createForFamilyOwner).toHaveBeenCalledTimes(1);
    const input = alerts.createForFamilyOwner.mock.calls[0][0];
    expect(input.priority).toBe('CRITICAL');
    expect(input.type).toBe('CHILD_WELLBEING_CHECKIN');
    expect(input.body).toContain('يوسف');
    expect(JSON.stringify(input)).not.toContain(SECRET);
    expect(JSON.stringify(input)).not.toContain('SELF_HARM');
    // No `data` blob — the place a raw quote ends up when someone later adds
    // "context" to the alert.
    expect(input.data).toBeUndefined();
    // The dedupe key is built on the FAMILY's business date, so a second signal
    // the same evening is the same conversation. (`notification-source-key.ts`
    // escapes `:` inside a segment to `_` so two different compositions can
    // never collide — hence `distress_` in the key, not `distress:`.)
    expect(input.sourceEventId).toContain('distress_2026-08-15');
    expect(input.sourceEventId.startsWith('signal:c1:')).toBe(true);
  });

  it('uses the FAMILY’s business date, never a UTC day (B8 task 8)', async () => {
    await service.checkin('c1', 'f1', SECRET, new Date('2026-08-15T23:30:00Z'));
    expect(familyDate.getBusinessDate).toHaveBeenCalledWith('f1', new Date('2026-08-15T23:30:00Z'));
  });

  it('an ORDINARY check-in writes nothing, alerts nobody, and still calls no provider', async () => {
    const result = await service.checkin('c1', 'f1', 'اليوم كان جيدًا وأنهيت واجبي');

    expect(result).toEqual({ escalated: false, card: null, code: null, parentAlerted: false });
    expect(memory.record).not.toHaveBeenCalled();
    expect(alerts.createForFamilyOwner).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('reports parentAlerted=false when the alert was deduped — that is a success, not a failure', async () => {
    alerts.createForFamilyOwner.mockResolvedValue(false);
    const result = await service.checkin('c1', 'f1', SECRET);
    expect(result.escalated).toBe(true);
    expect(result.parentAlerted).toBe(false);
  });

  it('ownership is checked first — another family’s child never reaches the classifier', async () => {
    children.getChildOrThrow.mockRejectedValue(new Error('CHILD_NOT_FOUND'));
    await expect(service.checkin('other', 'f1', SECRET)).rejects.toThrow('CHILD_NOT_FOUND');
    expect(memory.record).not.toHaveBeenCalled();
    expect(alerts.createForFamilyOwner).not.toHaveBeenCalled();
  });
});
