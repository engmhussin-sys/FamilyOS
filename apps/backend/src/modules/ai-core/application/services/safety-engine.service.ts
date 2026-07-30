import { Injectable } from '@nestjs/common';

const ALLOWED_RECOMMENDATION_TYPES = new Set([
  'RE_ENABLE_PROTECTION',
  'REVIEW_DEVICE_SECURITY',
  'SET_SCREEN_TIME_POLICY',
  'COMPLETE_DEVICE_VERIFICATION',
  'REVIEW_POLICY_EFFECTIVENESS',
  'ALL_CLEAR',
]);

/** Matches this project's own standing no-spyware principle
 * (product_information/refusal_handling equivalent for this codebase:
 * "does NOT design spyware... prefer AI risk detection over raw
 * surveillance"). A recommendation suggesting secrecy or covert
 * monitoring is rejected regardless of source — deterministic,
 * unconditional, and checked before anything reaches a parent. */
const UNSAFE_PATTERNS = [
  /secretly/i,
  /without (?:them|him|her|the child) knowing/i,
  /hidden monitoring/i,
  /spy on/i,
  /read (?:their|his|her) (?:messages|texts|chats)/i,
  /install.*without.*consent/i,
];

export interface ISafetyCheckResult {
  isSafe: boolean;
  rejectionReason: string | null;
}

/**
 * Sprint 7's Safety Engine. "Unsafe recommendations must be rejected
 * locally without requiring any external model" — this is a pure,
 * offline, deterministic function; it runs identically whether or not
 * any LLM provider is reachable.
 */
@Injectable()
export class SafetyEngineService {
  validate(recommendationType: string | null, title: string, body: string): ISafetyCheckResult {
    if (recommendationType !== null && !ALLOWED_RECOMMENDATION_TYPES.has(recommendationType)) {
      return { isSafe: false, rejectionReason: `Unknown recommendation type: ${recommendationType}` };
    }

    const combinedText = `${title} ${body}`;
    for (const pattern of UNSAFE_PATTERNS) {
      if (pattern.test(combinedText)) {
        return { isSafe: false, rejectionReason: 'Recommendation text matched an unsafe pattern.' };
      }
    }

    return { isSafe: true, rejectionReason: null };
  }
}
