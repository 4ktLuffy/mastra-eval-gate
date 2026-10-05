/**
 * Paired, error-aware comparison of two Mastra experiments.
 *
 * Pure functions over rows as Mastra stores them, so the logic is testable without storage.
 * `loadExperimentRows` (load.ts) reads the rows from a Mastra instance.
 */

import {
  bootstrapMeanCI,
  holm,
  mcnemarExactPValue,
  mean,
  minimumDetectableEffect,
  sd,
  signFlipPValue,
} from './stats.js';

export type Direction = 'higher-is-better' | 'lower-is-better';

/** One experiment result row (one target run of one item, possibly one of several attempts). */
export interface ResultRow {
  itemId: string;
  attempt?: number | null;
  error?: unknown;
}

/** One persisted score row. For experiment scores, `entityId` is the dataset item ID. */
export interface ScoreRow {
  scorerId: string;
  entityId: string;
  score: number | null | undefined;
  /** Attempt this score belongs to, when known (Mastra encodes it in caller-driven score ids). */
  attempt?: number | null;
}

export interface ExperimentRows {
  id: string;
  results: ResultRow[];
  scores: ScoreRow[];
}

export interface ScorerThreshold {
  /** Largest drop (in score units) that still counts as no regression. */
  value: number;
  direction?: Direction;
}

export interface CompareOptions {
  thresholds?: Record<string, ScorerThreshold>;
  /** Significance level for the regression test (Holm-adjusted across scorers). Default 0.05. */
  alpha?: number;
  /** Items that newly fail in the candidate before reliability counts as regressed. Default 0. */
  maxNewTargetFailures?: number;
  /**
   * Net items that lose their score for reasons other than a target failure (lost in the
   * candidate minus lost in the baseline). Default 0.
   */
  maxCoverageLoss?: number;
  /**
   * Accept a candidate that did not run some of the baseline's items. Default false: an item the
   * candidate never ran is a coverage failure, since the gate can say nothing about it.
   */
  allowSubset?: boolean;
  /** Seed for Monte Carlo tests and bootstrap intervals. Default 1. */
  seed?: number;
  /**
   * Keep scores that scorers produced for runs whose target failed. Default false: Mastra scores
   * failed runs with empty input and output, and several prebuilt scorers then return a perfect
   * 1.0, so those rows describe the failure, not the agent's quality. Failures are counted under
   * reliability instead. A score is matched to its attempt by `ScoreRow.attempt`, or to the item's
   * only result row; when neither works it is kept and counted in a warning.
   */
  includeScoresOfFailedRuns?: boolean;
  /**
   * Use the mid-p sign-flip test. More power on discrete (pass/fail, 3-level) scores, but in
   * bench/power.ts its false-alarm rate reached 6.65% (vs 5.7% for the exact test) when the true
   * drop equals the tolerance. Default false.
   */
  midP?: boolean;
}

/** Why an item has no score for a scorer in one run. */
export type MissingReason = 'target-error' | 'no-score' | 'not-run';

export interface ScorerReport {
  scorerId: string;
  direction: Direction;
  tolerance: number;
  /** 'ok' when the scorer ran in both experiments. */
  status: 'ok' | 'missing-in-baseline' | 'missing-in-candidate';
  /** Items scored in both runs (after averaging repeated attempts per item). */
  pairedN: number;
  /** Means over the paired items only. */
  meanA: number;
  meanB: number;
  /** Paired mean change, signed so negative = worse regardless of direction. */
  change: number;
  /** 95% bootstrap interval for `change`. */
  changeCI: [number, number];
  /** One-sided sign-flip p-value for "worse by more than tolerance". */
  pValue: number;
  /** Holm-adjusted across scorers. */
  pAdjusted: number;
  /** Approximate smallest regression this comparison can detect (alpha, 80% power). */
  minimumDetectable: number;
  regressed: boolean;
  /** The point estimate is beyond tolerance but the evidence is not significant. */
  inconclusive: boolean;
  /** Items scored in A but not in B, by reason. */
  lostInB: Record<MissingReason, number>;
  /** Items scored in B but not in A, by reason. */
  lostInA: Record<MissingReason, number>;
  /** The old, unpaired view, kept for comparison: means over every score row in each run. */
  unpaired: { meanA: number; meanB: number; nA: number; nB: number };
}

export interface ReliabilityReport {
  /** Items present in both runs. */
  items: number;
  failedA: number;
  failedB: number;
  /** Failed in B but not in A. */
  newFailures: number;
  /** Failed in A but not in B. */
  fixedFailures: number;
  /** Exact one-sided McNemar p-value for "B fails more often". */
  pValue: number;
  regressed: boolean;
}

export interface GateReason {
  kind: 'regression' | 'reliability' | 'coverage' | 'missing-scorer';
  scorerId?: string;
  message: string;
}

export interface Comparison {
  baselineId: string;
  candidateId: string;
  passed: boolean;
  reasons: GateReason[];
  warnings: string[];
  reliability: ReliabilityReport;
  scorers: Record<string, ScorerReport>;
}

const isFailed = (r: ResultRow) => r.error !== null && r.error !== undefined;

/** Result rows of one experiment, indexed for attempt-level lookups. */
interface RunIndex {
  /** item -> attempt -> failed */
  attempts: Map<string, Map<number, boolean>>;
}

function indexRun(results: ResultRow[]): RunIndex {
  const attempts = new Map<string, Map<number, boolean>>();
  for (const r of results) {
    const byAttempt = attempts.get(r.itemId) ?? new Map<number, boolean>();
    byAttempt.set(r.attempt ?? 0, isFailed(r));
    attempts.set(r.itemId, byAttempt);
  }
  return { attempts };
}

/** Did the target run behind this score fail? undefined when it can't be told. */
function scoreFromFailedRun(row: ScoreRow, run: RunIndex): boolean | undefined {
  const byAttempt = run.attempts.get(row.entityId);
  if (!byAttempt) return undefined;
  if (row.attempt !== null && row.attempt !== undefined && byAttempt.has(row.attempt)) return byAttempt.get(row.attempt);
  if (byAttempt.size === 1) return [...byAttempt.values()][0];
  if ([...byAttempt.values()].every(Boolean)) return true;
  if ([...byAttempt.values()].every(f => !f)) return false;
  return undefined;
}

interface ScorerSide {
  /** item -> mean of its valid scores */
  byItem: Map<string, number>;
  /** Any finite score at all for this scorer (before excluding failed runs). */
  ran: boolean;
  /** Non-finite scores (NaN, Infinity), treated as no score. */
  invalid: number;
  /** Scores whose run (failed or not) could not be told apart. */
  unattributed: number;
}

function scorerSide(rows: ScoreRow[], scorerId: string, run: RunIndex, dropFailed: boolean): ScorerSide {
  const acc = new Map<string, number[]>();
  let ran = false, invalid = 0, unattributed = 0;
  for (const r of rows) {
    if (r.scorerId !== scorerId || r.score === null || r.score === undefined) continue;
    if (!Number.isFinite(r.score)) {
      invalid++;
      continue;
    }
    ran = true;
    const failed = scoreFromFailedRun(r, run);
    if (failed === undefined && run.attempts.has(r.entityId)) unattributed++;
    if (dropFailed && failed) continue;
    const list = acc.get(r.entityId) ?? [];
    list.push(r.score);
    acc.set(r.entityId, list);
  }
  return { byItem: new Map([...acc].map(([item, xs]) => [item, mean(xs)])), ran, invalid, unattributed };
}

/** Per item: did any attempt fail? */
function anyAttemptFailed(run: RunIndex): Map<string, boolean> {
  return new Map([...run.attempts].map(([item, byAttempt]) => [item, [...byAttempt.values()].some(Boolean)]));
}

function missingReason(item: string, run: RunIndex): MissingReason {
  const byAttempt = run.attempts.get(item);
  if (!byAttempt) return 'not-run';
  return [...byAttempt.values()].every(Boolean) ? 'target-error' : 'no-score';
}

const emptyReasons = (): Record<MissingReason, number> => ({ 'target-error': 0, 'no-score': 0, 'not-run': 0 });

/** Smallest p the exact one-sided sign-flip test can return with n non-zero diffs. */
const smallestP = (n: number) => 2 ** -n;

export function compareRows(baseline: ExperimentRows, candidate: ExperimentRows, options: CompareOptions = {}): Comparison {
  const {
    thresholds = {},
    alpha = 0.05,
    maxNewTargetFailures = 0,
    maxCoverageLoss = 0,
    allowSubset = false,
    seed = 1,
    includeScoresOfFailedRuns = false,
    midP = false,
  } = options;
  const warnings: string[] = [];
  const reasons: GateReason[] = [];

  const runA = indexRun(baseline.results);
  const runB = indexRun(candidate.results);
  const failA = anyAttemptFailed(runA);
  const failB = anyAttemptFailed(runB);

  // Reliability over items both runs attempted: an item counts as failing if any attempt failed.
  let failedA = 0, failedB = 0, newFailures = 0, fixedFailures = 0, both = 0;
  for (const [item, fa] of failA) {
    if (!failB.has(item)) continue;
    const fb = failB.get(item)!;
    both++;
    if (fa) failedA++;
    if (fb) failedB++;
    if (!fa && fb) newFailures++;
    if (fa && !fb) fixedFailures++;
  }
  const onlyA = [...failA.keys()].filter(i => !failB.has(i)).length;
  const onlyB = [...failB.keys()].filter(i => !failA.has(i)).length;
  if (onlyA || onlyB) {
    warnings.push(`Item sets differ: ${onlyA} only in baseline, ${onlyB} only in candidate. Scores are compared on shared items only.`);
  }
  if (onlyA > 0 && !allowSubset) {
    reasons.push({
      kind: 'coverage',
      message: `The candidate did not run ${onlyA} of the baseline's ${failA.size} item(s), so nothing is known about them (allowSubset to accept).`,
    });
  }
  const reliability: ReliabilityReport = {
    items: both,
    failedA,
    failedB,
    newFailures,
    fixedFailures,
    pValue: mcnemarExactPValue(newFailures, fixedFailures),
    regressed: newFailures - fixedFailures > maxNewTargetFailures,
  };
  if (reliability.regressed) {
    reasons.push({
      kind: 'reliability',
      message: `${newFailures} item(s) fail in the candidate that passed in the baseline (${fixedFailures} fixed); allowed net ${maxNewTargetFailures}.`,
    });
  }

  const scorerIds = [...new Set([...baseline.scores, ...candidate.scores].map(s => s.scorerId))].sort();
  const reports: ScorerReport[] = [];

  for (const scorerId of scorerIds) {
    const threshold = thresholds[scorerId] ?? { value: 0 };
    const direction: Direction = threshold.direction ?? 'higher-is-better';
    const sign = direction === 'higher-is-better' ? 1 : -1;
    const sideA = scorerSide(baseline.scores, scorerId, runA, !includeScoresOfFailedRuns);
    const sideB = scorerSide(candidate.scores, scorerId, runB, !includeScoresOfFailedRuns);
    const a = sideA.byItem;
    const b = sideB.byItem;

    if (sideA.invalid) warnings.push(`"${scorerId}": ${sideA.invalid} non-finite score(s) in the baseline were ignored.`);
    if (sideB.invalid) warnings.push(`"${scorerId}": ${sideB.invalid} non-finite score(s) in the candidate were ignored.`);
    if (sideA.unattributed + sideB.unattributed > 0) {
      warnings.push(`"${scorerId}": ${sideA.unattributed + sideB.unattributed} score(s) could not be matched to an attempt, so a score from a failed attempt may be included.`);
    }

    const paired = [...a.keys()].filter(i => b.has(i)).sort();
    const changes = paired.map(i => sign * (b.get(i)! - a.get(i)!));
    const lostInB = emptyReasons();
    const lostInA = emptyReasons();
    for (const i of a.keys()) if (!b.has(i)) lostInB[missingReason(i, runB)]++;
    for (const i of b.keys()) if (!a.has(i)) lostInA[missingReason(i, runA)]++;

    const status: ScorerReport['status'] = !sideA.ran ? 'missing-in-baseline' : !sideB.ran ? 'missing-in-candidate' : 'ok';
    const n = changes.length;
    const report: ScorerReport = {
      scorerId,
      direction,
      tolerance: threshold.value,
      status,
      pairedN: n,
      meanA: mean(paired.map(i => a.get(i)!)),
      meanB: mean(paired.map(i => b.get(i)!)),
      change: mean(changes),
      changeCI: bootstrapMeanCI(changes, { seed }),
      pValue: status === 'ok' ? signFlipPValue(changes, threshold.value, { seed, midP }) : Number.NaN,
      pAdjusted: Number.NaN,
      // Below this n the exact test cannot reach alpha at all, so no drop is detectable.
      minimumDetectable: n > 0 && smallestP(n) >= alpha ? Number.POSITIVE_INFINITY : minimumDetectableEffect(sd(changes), n, alpha),
      regressed: false,
      inconclusive: false,
      lostInB,
      lostInA,
      unpaired: {
        meanA: mean(baseline.scores.filter(s => s.scorerId === scorerId && Number.isFinite(s.score)).map(s => s.score as number)),
        meanB: mean(candidate.scores.filter(s => s.scorerId === scorerId && Number.isFinite(s.score)).map(s => s.score as number)),
        nA: baseline.scores.filter(s => s.scorerId === scorerId && Number.isFinite(s.score)).length,
        nB: candidate.scores.filter(s => s.scorerId === scorerId && Number.isFinite(s.score)).length,
      },
    };
    reports.push(report);
  }

  const adjusted = holm(reports.map(r => r.pValue));
  reports.forEach((r, k) => {
    r.pAdjusted = adjusted[k]!;
    if (r.status === 'missing-in-candidate') {
      reasons.push({ kind: 'missing-scorer', scorerId: r.scorerId, message: `Scorer "${r.scorerId}" scored items in the baseline but none in the candidate.` });
      return;
    }
    if (r.status === 'missing-in-baseline') {
      warnings.push(`Scorer "${r.scorerId}" has no scores in the baseline; nothing to compare it with.`);
      return;
    }
    if (r.pairedN === 0) {
      reasons.push({ kind: 'coverage', scorerId: r.scorerId, message: `"${r.scorerId}" has no item scored in both experiments, so the candidate can't be compared.` });
      return;
    }
    // Tolerate float noise when the drop equals the tolerance exactly.
    const eps = 1e-9 * Math.max(1, Math.abs(r.tolerance), Math.abs(r.meanA), Math.abs(r.meanB));
    const beyond = r.change < -r.tolerance - eps;
    r.regressed = beyond && r.pAdjusted < alpha;
    r.inconclusive = beyond && !r.regressed;
    if (r.regressed) {
      reasons.push({
        kind: 'regression',
        scorerId: r.scorerId,
        message: `"${r.scorerId}" is worse by ${fmt(-r.change)} on ${r.pairedN} paired items (95% CI of change ${fmt(r.changeCI[0])} to ${fmt(r.changeCI[1])}; Holm p = ${fmt(r.pAdjusted)}).`,
      });
    } else if (r.inconclusive) {
      const detect = Number.isFinite(r.minimumDetectable)
        ? `smallest reliably detectable drop is about ${fmt(r.minimumDetectable)}`
        : `${r.pairedN} items can never reach p < ${alpha} with this test (need at least ${Math.ceil(Math.log2(1 / alpha)) + 1})`;
      warnings.push(`"${r.scorerId}" looks worse by ${fmt(-r.change)} but that is not significant at n = ${r.pairedN} (Holm p = ${fmt(r.pAdjusted)}); ${detect}.`);
    } else if (!Number.isFinite(r.minimumDetectable)) {
      warnings.push(`"${r.scorerId}": ${r.pairedN} paired item(s) are too few for this test to detect any regression.`);
    } else if (r.tolerance > 0 && r.minimumDetectable > r.tolerance) {
      warnings.push(`"${r.scorerId}": with ${r.pairedN} items this comparison can only reliably see drops of about ${fmt(r.minimumDetectable)}, larger than the tolerance ${fmt(r.tolerance)}.`);
    }
    // Net, like reliability: a scorer that errors now and then (an LLM judge hitting capacity
    // limits) loses items in both runs, and only the excess counts against the candidate.
    const lostToScorer = r.lostInB['no-score'];
    const gainedFromScorer = r.lostInA['no-score'];
    if (lostToScorer - gainedFromScorer > maxCoverageLoss) {
      reasons.push({
        kind: 'coverage',
        scorerId: r.scorerId,
        message: `"${r.scorerId}" produced no valid score for ${lostToScorer} item(s) the baseline scored (and scored ${gainedFromScorer} the baseline didn't), with no target failure (scorer error, skipped, or non-finite); allowed net ${maxCoverageLoss}.`,
      });
    }
    if (r.lostInB['target-error'] > 0) {
      warnings.push(`"${r.scorerId}": ${r.lostInB['target-error']} item(s) scored in the baseline have no score in the candidate because the target failed; they are excluded from the paired mean and counted under reliability.`);
    }
  });

  return {
    baselineId: baseline.id,
    candidateId: candidate.id,
    passed: reasons.length === 0,
    reasons,
    warnings,
    reliability,
    scorers: Object.fromEntries(reports.map(r => [r.scorerId, r])),
  };
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  return Math.abs(x) >= 0.001 || x === 0 ? x.toFixed(3) : x.toExponential(1);
}
