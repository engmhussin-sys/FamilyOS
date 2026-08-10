import { IExplainableSubScore } from '../../domain/digital-twin.types';

/**
 * Pure function \u2014 zero I/O. Architecture 1.0 \u00a76.2, Decision 2:
 * Growth Score IS the weighted composite of every other sub-score,
 * NOT physical growth. Averages whichever sub-scores are non-null,
 * and downgrades confidence when fewer are available rather than
 * silently presenting a false-precision number.
 */
export function computeGrowthScore(subScores: Array<IExplainableSubScore | null>): IExplainableSubScore | null {
  const present = subScores.filter((s): s is IExplainableSubScore => s !== null);
  if (present.length === 0) return null;

  const average = present.reduce((sum, s) => sum + s.score, 0) / present.length;

  return {
    score: Math.round(average),
    inputs: { contributingSubScores: present.length, totalPossibleSubScores: subScores.length },
    confidence: present.length >= 5 ? 'HIGH' : present.length >= 3 ? 'MEDIUM' : 'LOW',
  };
}
