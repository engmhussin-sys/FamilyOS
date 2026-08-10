import { HYDRATION_TARGET_ML_BY_AGE } from '../../domain/health.types';

/**
 * Pure function \u2014 zero I/O, zero dependency \u2014 same discipline as
 * ai-core's RuleEngineService.evaluate(). Deliberately a standalone
 * function, not a class, since there's no state to inject and no
 * reason to force a DI wrapper around a lookup table.
 */
export function computeHydrationTargetMl(ageYears: number): number {
  const band = HYDRATION_TARGET_ML_BY_AGE.find((b) => ageYears <= b.maxAge);
  return band ? band.targetMl : HYDRATION_TARGET_ML_BY_AGE[HYDRATION_TARGET_ML_BY_AGE.length - 1].targetMl;
}
