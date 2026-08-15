/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';

import { AI_PROVIDER, type IAIProvider } from '../../../ai-core/domain/ai-provider.port';
import {
  CATEGORY_ACTIVITIES,
  PROGRAM_CATEGORY_LABEL_AR,
  type ProgramCategory,
} from '../../../../shared/rewards/program-taxonomy';
import { findSurah } from '../../../../shared/rewards/quran';
import { describeTargetSpec } from '../../../../shared/rewards/target-spec';
import { ageInYears } from '../../domain/program-rules';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { RewardProgramService } from './reward-program.service';
import type { CreateRewardProgramDto } from '../dto/reward-program.dto';

export interface RewardProgramSuggestion {
  /** Deterministic id derived from (childId, category, activity, target) —
   * the same inputs always produce the same id, which is what lets a parent
   * accept a suggestion they saw a minute ago without a server-side session. */
  readonly suggestionId: string;
  readonly rationaleAr: string;
  readonly draft: CreateRewardProgramDto;
  readonly previewAr: string;
}

/**
 * AI REWARD RECOMMENDATION — ADVISORY ONLY (CONTEXT §3 principle 2).
 *
 * THREE THINGS THIS SERVICE CANNOT DO, and they are structural, not policed:
 *   1. It cannot create a program. It returns DRAFTS. The only way a draft
 *      becomes a row is `accept()`, which requires a parent's session and calls
 *      the ordinary `RewardProgramService.create` — the same validation path a
 *      hand-authored program goes through, with no bypass.
 *   2. It cannot grant. It has no access to the ledger, to the outbox, or to
 *      the verification engine.
 *   3. It cannot approve an achievement. There is no method here that touches
 *      `achievement_requests`.
 *
 * NO LLM PER EVENT (CONTEXT §3 principle 5). The suggestions themselves are
 * DETERMINISTIC — age bands, the child's category history and their current
 * screen-time posture, run through a small table. The provider abstraction is
 * used, if it is configured at all, for ONE thing: rephrasing the Arabic
 * rationale more warmly. That is the same division `RecommendationEngineService`
 * already uses in this codebase (decide deterministically, phrase optionally),
 * and reusing it is why there is no second AI architecture here.
 */
@Injectable()
export class RewardSuggestionService {
  private readonly logger = new Logger(RewardSuggestionService.name);

  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    private readonly programs: RewardProgramService,
    @Inject(AI_PROVIDER) private readonly ai: IAIProvider,
    private readonly familyDate: FamilyDateService,
  ) {}

  /**
   * Up to three drafts, ordered most-relevant first. Nothing is written.
   */
  async suggest(familyId: string, childId: string, now = new Date()): Promise<RewardProgramSuggestion[]> {
    const child = await this.repo.findChild(childId);
    if (!child) {
      throw new NotFoundException({ code: 'CHILD_NOT_FOUND', messageAr: 'الطفل غير موجود.' });
    }

    // B2: the suggestion engine reads the same calendar as the engine that
    // will enforce `minAge` if the parent accepts a draft — otherwise a child
    // could be offered a program on the day they turn eligible and then be
    // refused it, or the reverse.
    const age = ageInYears(new Date(child.dateOfBirth), now, await this.familyDate.timeZoneOf(familyId));
    const existing = await this.repo.listProgramsForChild(childId);
    const usedCategories = new Set<string>(existing.map((p: any) => String(p.category)));

    const candidates = this.rankCategories(age, usedCategories);
    const out: RewardProgramSuggestion[] = [];

    for (const category of candidates.slice(0, 3)) {
      const draft = this.draftFor(category, age, childId);
      if (!draft) continue;
      const summary = describeTargetSpec(draft.activity, draft.targetSpec as any);
      const rationaleAr = this.rationale(category, age, usedCategories.has(category));

      out.push({
        suggestionId: this.idFor(childId, draft),
        rationaleAr: await this.maybePhrase(rationaleAr),
        draft,
        previewAr: `${PROGRAM_CATEGORY_LABEL_AR[category]} · ${summary} · ${draft.durationMinutes} دقيقة · ${
          (draft.rewardSpec as any).amount
        } نقطة`,
      });
    }

    return out;
  }

  /**
   * THE PARENT'S EXPLICIT ACCEPT. This is the only door, and it is a normal
   * parent-authenticated create: the suggestion is re-derived server-side from
   * `(childId, suggestionId)` rather than trusted from the request body, so a
   * client cannot post a "suggestion" the AI never made and get it waved
   * through a different validation path.
   */
  async accept(
    familyId: string,
    userId: string,
    childId: string,
    suggestionId: string,
    now = new Date(),
  ): Promise<any> {
    const suggestions = await this.suggest(familyId, childId, now);
    const chosen = suggestions.find((s) => s.suggestionId === suggestionId);
    if (!chosen) {
      throw new BadRequestException({
        code: 'SUGGESTION_NOT_FOUND',
        messageAr: 'هذا الاقتراح لم يعد متاحًا. اطلب اقتراحات جديدة.',
      });
    }
    return this.programs.create(familyId, userId, chosen.draft);
  }

  // --- the deterministic part ----------------------------------------------

  /** Age bands, then "what this child is not doing yet" — a stable order. */
  private rankCategories(age: number, used: Set<string>): ProgramCategory[] {
    const byAge: ProgramCategory[] =
      age < 8
        ? ['QURAN', 'READING', 'HABITS', 'MANNERS', 'ARABIC', 'SPORT']
        : age < 12
          ? ['QURAN', 'READING', 'MATH', 'ARABIC', 'ENGLISH', 'SPORT']
          : ['QURAN', 'STUDY', 'PROGRAMMING', 'ENGLISH', 'SCIENCE', 'SPORT'];

    // Unused categories first. Suggesting a seventh Quran program to a child who
    // already has six is the sort of "recommendation" that teaches a parent to
    // ignore the feature.
    return [...byAge.filter((c) => !used.has(c)), ...byAge.filter((c) => used.has(c))];
  }

  private draftFor(category: ProgramCategory, age: number, childId: string): CreateRewardProgramDto | null {
    const activity = CATEGORY_ACTIVITIES[category][0];
    const duration = age < 8 ? 10 : age < 12 ? 20 : 30;
    const points = age < 8 ? 10 : age < 12 ? 20 : 30;

    let targetSpec: Record<string, unknown>;
    if (category === 'QURAN') {
      // Short, well-known surahs for younger children; Al-Mulk from 10 up —
      // the brief's own worked example, and a real ayah range either way.
      const surahNumber = age < 8 ? 114 : age < 12 ? 78 : 67;
      const surah = findSurah(surahNumber);
      if (!surah) return null;
      const toAyah = Math.min(5, surah.ayahCount);
      targetSpec = { surahNumber, fromAyah: 1, toAyah };
    } else if (activity === 'READ_PAGES') {
      targetSpec = { quantity: age < 8 ? 3 : 10, unit: 'صفحة' };
    } else if (activity === 'SOLVE_PROBLEMS') {
      targetSpec = { quantity: 10, unit: 'مسألة' };
    } else {
      targetSpec = { quantity: 1, unit: 'جلسة' };
    }

    return {
      childId,
      category,
      activity,
      targetSpec,
      durationMinutes: duration,
      // Advisory drafts NEVER propose a weak verification level. A suggestion
      // that quietly proposed SELF_CHECK would be the AI relaxing a control.
      verificationLevel: category === 'QURAN' ? 'RECITATION_SUBMISSION' : 'PARENT_CONFIRMATION',
      verificationConfig: {},
      rewardSpec: { type: 'POINTS', amount: points },
      frequency: 'DAILY',
      maxPerDay: 1,
      maxPerWeek: 7,
      minAge: 0,
      difficulty: age < 8 ? 'EASY' : 'MEDIUM',
      requiresParentApproval: false,
      streakMultiplierBps: 30000,
    };
  }

  private rationale(category: ProgramCategory, age: number, alreadyUsed: boolean): string {
    const label = PROGRAM_CATEGORY_LABEL_AR[category];
    if (alreadyUsed) {
      return `اقتراح لتوسيع ما يفعله طفلك بالفعل في ${label}، بمستوى مناسب لعمر ${age} سنة.`;
    }
    return `طفلك (${age} سنة) ليس لديه برنامج في ${label} بعد، وهذه بداية مناسبة لعمره.`;
  }

  private idFor(childId: string, draft: CreateRewardProgramDto): string {
    return createHash('sha256')
      .update(`${childId}|${draft.category}|${draft.activity}|${JSON.stringify(draft.targetSpec)}`)
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * OPTIONAL, BEST-EFFORT PHRASING — and nothing else. The provider never sees
   * the child's data, never chooses a category and never decides an amount; it
   * is handed one already-decided Arabic sentence. If it is unconfigured, slow,
   * or returns something implausible, the deterministic sentence stands.
   */
  private async maybePhrase(text: string): Promise<string> {
    try {
      const phrased = (
        await this.ai.complete({
          systemPrompt:
            'أعد صياغة الجملة التالية بالعربية بأسلوب أدفأ وأقصر، دون إضافة أي معلومة جديدة ودون تغيير المعنى. أجب بالجملة فقط.',
          userMessage: text,
          sourceFeature: 'rewards-engine.suggestion',
        })
      ).trim();
      // A "rephrasing" three times the length is not a rephrasing.
      if (!phrased || phrased.length > text.length * 3) return text;
      return phrased;
    } catch (err) {
      // Unconfigured provider, timeout, circuit open — the deterministic
      // sentence stands. The suggestion is never blocked on an LLM.
      this.logger.debug(`ai.phrasing_skipped: ${err instanceof Error ? err.message : String(err)}`);
      return text;
    }
  }
}
