/**
 * Paired, error-aware comparison of two Mastra experiments.
 *
 * Pure functions over rows as Mastra stores them, so the logic is testable without storage.
 * `loadExperimentRows` (load.ts) reads the rows from a Mastra instance.
 *
 * The verdict is one of:
 *   pass          no evidence of a regression (not proof that quality is fine)
 *   fail          a regression in quality, reliability, or a scorer the candidate lost
 *   insufficient  the comparison can't support a verdict: nothing scored, an unfinished run,
 *                 scorer outages, too few paired items, items the candidate didn't run
 */

import {
  bettingPValue,
  rng,
  bootstrapMeanCI,
  holm,
  mcnemarExactPValue,
  mean,
  minimumDetectableEffect,
  minimumItemsForAlpha,
  sd,
  signFlipPValue,
  smallestSignFlipP,
} from './stats.js';

export type Direction = 'higher-is-better' | 'lower-is-better';

/** One experiment result row (one target run of one item, possibly one of several attempts). */
export interface ResultRow {
  itemId: string;
  attempt?: number | null;
  error?: unknown;
  /** Wall-clock time of the target run, when known (Mastra: completedAt - startedAt). */
  durationMs?: number | null;
  /** Tokens the target used, when known (Mastra agents: output.usage.totalTokens). */
  tokens?: number | null;
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
  /** Mastra experiment status ('pending' | 'running' | 'completed' | 'failed'), when known. */
  status?: string | null;
  datasetVersion?: number | null;
}

export interface ScorerThreshold {
  /** Largest drop (in score units) that still counts as no regression. */
  value: number;
  direction?: Direction;
}

export type QualityTest = 'sign-flip' | 'betting';

export interface ResourceThreshold {
  /** Largest allowed increase as a fraction (0.2 = 20% more), on the geometric mean per item. */
  maxIncrease: number;
}

export interface CompareOptions {
  thresholds?: Record<string, ScorerThreshold>;
  /**
   * The quality test. 'sign-flip' (default): exact when paired changes are symmetric under no
   * regression; the most powerful here, and it gains most from repeated runs (pass several runs:
   * items are averaged across them), but ~12% false alarms on skewed changes (bench/gate-sim.ts).
   * 'betting': no symmetry assumption, for scores within `scoreBounds` (0-3.3% false alarms on the
   * same skewed changes). Like any item-level test it treats items as a sample of tasks (H0 is about
   * that population's mean change), so items are taken in a seeded random order; it needs equal run
   * counts per side and much more data to detect the same drop (0.1 over 20 continuous items: 3% vs 63%).
   */
  test?: QualityTest;
  /** Score range per scorer for the 'betting' test. Default { min: 0, max: 1 }. */
  scoreBounds?: Record<string, { min: number; max: number }>;
  /** Fail when per-item run time grows beyond this (significant, one-sided). Off unless set. */
  latency?: ResourceThreshold;
  /** Fail when per-item token use grows beyond this (significant, one-sided). Off unless set. */
  tokens?: ResourceThreshold;
  /**
   * Scorers that must have scores in both experiments. A missing one fails the gate (missing in
   * the candidate) or makes it insufficient (missing in the baseline). Without this, a scorer that
   * never ran anywhere is invisible to the gate.
   */
  expectedScorers?: string[];
  /** Significance level for the quality test (Holm-adjusted across scorers). Default 0.05. */
  alpha?: number;
  /**
   * Expected number of extra failed runs the candidate may have before reliability fails: the sum
   * over shared items of (candidate failure rate - baseline failure rate) where positive, so items
   * that got fixed don't offset items that broke. With one attempt per item this is the number of
   * newly failing items. Default 0.
   */
  maxNewTargetFailures?: number;
  /**
   * Scores the candidate's scorer lost relative to the baseline (scorer error, skipped, non-finite),
   * counted per successful attempt: for each shared item, the drop in the share of successful
   * attempts that got a valid score, summed. Beyond this the verdict is 'insufficient'. Default 0.
   */
  maxCoverageLoss?: number;
  /**
   * How reliability is decided. 'strict' (default): fail when the extra failures exceed
   * `maxNewTargetFailures`, because a crash is a defect. 'statistical': also require the increase to
   * be significant (one-sided paired sign-flip on per-item failure rates, i.e. exact McNemar for single
   * attempts), for providers with background flakiness. In bench/gate-sim.ts, with both runs failing
   * 5% of items at random, 'strict' fails 64-92% of comparisons and 'statistical' about alpha.
   */
  reliability?: 'strict' | 'statistical';
  /**
   * Item id -> cluster id. Items in one cluster (variants of one template, one customer, one
   * document) are not independent; with clusters the quality test runs on per-cluster mean changes.
   * Unclustered, bench/gate-sim.ts measured 13-23% false alarms with 5 correlated clusters.
   */
  clusters?: Record<string, string>;
  /** Accept a candidate that did not run some of the baseline's items. Default false (insufficient). */
  allowSubset?: boolean;
  /** Require both experiments to have status 'completed' when the status is known. Default true. */
  requireCompleted?: boolean;
  /** Seed for Monte Carlo tests and bootstrap intervals. Default 1. */
  seed?: number;
  /** Monte Carlo resamples when an exact test is too large (n > 16), 1000 to 10,000,000; also caps the bootstrap at 5000. Default 20000. */
  resamples?: number;
  /**
   * Keep scores that scorers produced for runs whose target failed. Default false: Mastra scores
   * failed runs with empty input and output, and several prebuilt scorers then return a perfect
   * 1.0, so those rows describe the failure, not the agent's quality. Failures are counted under
   * reliability instead. A score is matched to its attempt by `ScoreRow.attempt`, or to the item's
   * only result row; when neither works it is kept and counted in a warning.
   */
  includeScoresOfFailedRuns?: boolean;
  /**
   * Mid-p variant of the 'sign-flip' test: more power on discrete scores, but in bench/power.ts its
   * false-alarm rate reached 6.65% when the true drop equals the tolerance. Default false.
   */
  midP?: boolean;
  /** How many items to list in `items` (the largest drops and new failures). Default 10. */
  itemDetail?: number;
}

/** Why an item has no score for a scorer in one run. */
export type MissingReason = 'target-error' | 'no-score' | 'not-run';

export interface ScorerReport {
  scorerId: string;
  /** The quality test used. */
  test: QualityTest;
  direction: Direction;
  tolerance: number;
  /** 'ok' when the scorer has scores in both experiments. */
  status: 'ok' | 'missing-in-baseline' | 'missing-in-candidate';
  /** Items scored in both runs (after averaging repeated attempts per item). */
  pairedN: number;
  /** Independent units the quality test used: clusters when `clusters` is set, else items. */
  testUnits: number;
  /** Means over the paired items only. */
  meanA: number;
  meanB: number;
  /** Paired mean change, signed so negative = worse regardless of direction. */
  change: number;
  /** 95% percentile bootstrap interval for `change` (descriptive; not simultaneous across scorers). */
  changeCI: [number, number];
  /** One-sided p-value of the quality test for "worse by more than tolerance". */
  pValue: number;
  /** Holm-adjusted across scorers. */
  pAdjusted: number;
  /**
   * Approximate smallest true drop this comparison would flag with 80% power, at Holm's worst-case
   * level and including the tolerance. NaN when not estimable, Infinity when there are too few items.
   */
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
  /** Items with at least one failed attempt. */
  failedA: number;
  failedB: number;
  /** Items whose failure rate went up / down. */
  newFailures: number;
  fixedFailures: number;
  /** Sum over items of the increase in failure rate (gross: fixed items don't offset it). */
  excessFailures: number;
  /** One-sided p for "more failures": exact McNemar for single attempts, sign-flip on failure rates otherwise. */
  pValue: number;
  regressed: boolean;
}

export type Verdict = 'pass' | 'fail' | 'insufficient';

export interface GateReason {
  kind: 'regression' | 'reliability' | 'latency' | 'cost' | 'missing-scorer' | 'coverage' | 'no-evidence' | 'incomplete' | 'too-few-items';
  /** 'fail' reasons make the verdict 'fail'; 'insufficient' ones make it 'insufficient' (when nothing failed). */
  severity: 'fail' | 'insufficient';
  scorerId?: string;
  message: string;
}

export interface ItemDetail {
  itemId: string;
  scorerId?: string;
  kind: 'new-failure' | 'consistent-drop' | 'drop' | 'lost-score';
  baseline: number | null;
  candidate: number | null;
  /** new-failure: the candidate's error message, so a suspension or timeout reads differently from a crash. */
  error?: string;
}

export interface ResourceReport {
  /** Items with a value in both runs. */
  items: number;
  /** Geometric mean over items of candidate / baseline. */
  ratio: number;
  /** One-sided p-value for "grew by more than the allowed increase" (or by anything, when not set). */
  pValue: number;
  maxIncrease: number | null;
  regressed: boolean;
}

export interface Comparison {
  baselineId: string;
  candidateId: string;
  /** Number of experiments on each side (several runs of the same dataset can be compared together). */
  runs: { baseline: number; candidate: number };
  /** Run time and token use, per item, when the rows carry them. */
  resources: { latency?: ResourceReport; tokens?: ResourceReport };
  verdict: Verdict;
  /** verdict === 'pass' */
  passed: boolean;
  reasons: GateReason[];
  warnings: string[];
  reliability: ReliabilityReport;
  scorers: Record<string, ScorerReport>;
  /** The items behind the verdict: new failures, the largest drops, lost scores. */
  items: ItemDetail[];
}

/** Throws a TypeError on options that would silently weaken the gate (NaN, negative, out of range). */
export function validateOptions(options: CompareOptions): void {
  const finiteNonNeg = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const nonNegInt = (x: unknown) => finiteNonNeg(x) && Number.isInteger(x);
  const problems: string[] = [];
  for (const [id, t] of Object.entries(options.thresholds ?? {})) {
    if (!t || !finiteNonNeg(t.value)) problems.push(`thresholds.${id}.value must be a finite number >= 0 (got ${t?.value})`);
    if (t?.direction !== undefined && t.direction !== 'higher-is-better' && t.direction !== 'lower-is-better') {
      problems.push(`thresholds.${id}.direction must be 'higher-is-better' or 'lower-is-better'`);
    }
  }
  if (options.alpha !== undefined && !(typeof options.alpha === 'number' && options.alpha > 0 && options.alpha < 1)) {
    problems.push(`alpha must be in (0, 1) (got ${options.alpha})`);
  }
  if (options.maxNewTargetFailures !== undefined && !finiteNonNeg(options.maxNewTargetFailures)) {
    problems.push(`maxNewTargetFailures must be a finite number >= 0 (got ${options.maxNewTargetFailures})`);
  }
  if (options.maxCoverageLoss !== undefined && !finiteNonNeg(options.maxCoverageLoss)) {
    problems.push(`maxCoverageLoss must be a finite number >= 0 (got ${options.maxCoverageLoss})`);
  }
  if (options.resamples !== undefined && !(nonNegInt(options.resamples) && options.resamples >= 1000 && options.resamples <= 1e7)) {
    problems.push(`resamples must be an integer from 1000 to 10,000,000 (got ${options.resamples})`);
  }
  if (options.seed !== undefined && !(Number.isSafeInteger(options.seed))) problems.push(`seed must be an integer (got ${options.seed})`);
  if (options.itemDetail !== undefined && !nonNegInt(options.itemDetail)) problems.push(`itemDetail must be an integer >= 0`);
  if (options.test !== undefined && options.test !== 'sign-flip' && options.test !== 'betting') {
    problems.push(`test must be 'sign-flip' or 'betting' (got ${options.test})`);
  }
  for (const [id, b] of Object.entries(options.scoreBounds ?? {})) {
    if (!b || !Number.isFinite(b.min) || !Number.isFinite(b.max) || !(b.max > b.min)) problems.push(`scoreBounds.${id} must have finite min < max`);
  }
  for (const key of ['latency', 'tokens'] as const) {
    const r = options[key];
    if (r !== undefined && !(r && finiteNonNeg(r.maxIncrease))) problems.push(`${key}.maxIncrease must be a finite number >= 0`);
  }
  if (options.reliability !== undefined && options.reliability !== 'strict' && options.reliability !== 'statistical') {
    problems.push(`reliability must be 'strict' or 'statistical' (got ${options.reliability})`);
  }
  if (
    options.clusters !== undefined &&
    (typeof options.clusters !== 'object' || options.clusters === null || !Object.values(options.clusters).every(c => typeof c === 'string'))
  ) {
    problems.push('clusters must be an object mapping item id to a cluster id string');
  }
  if (options.expectedScorers !== undefined && !(Array.isArray(options.expectedScorers) && options.expectedScorers.every(s => typeof s === 'string' && s))) {
    problems.push('expectedScorers must be an array of scorer ids');
  }
  if (problems.length) throw new TypeError(`Invalid gate options:\n- ${problems.join('\n- ')}`);
}

const isFailed = (r: ResultRow) => r.error !== null && r.error !== undefined;

/** Result rows of one experiment: item -> attempt -> failed. */
type RunIndex = Map<string, Map<number, boolean>>;

function indexRun(results: ResultRow[]): RunIndex {
  const run: RunIndex = new Map();
  for (const r of results) {
    const byAttempt = run.get(r.itemId) ?? new Map<number, boolean>();
    byAttempt.set(r.attempt ?? 0, isFailed(r));
    run.set(r.itemId, byAttempt);
  }
  return run;
}

/** Did the target run behind this score fail? undefined when it can't be told. */
function scoreFromFailedRun(row: ScoreRow, run: RunIndex): boolean | undefined {
  const byAttempt = run.get(row.entityId);
  if (!byAttempt) return undefined;
  if (row.attempt !== null && row.attempt !== undefined && byAttempt.has(row.attempt)) return byAttempt.get(row.attempt);
  if (byAttempt.size === 1) return [...byAttempt.values()][0];
  if ([...byAttempt.values()].every(Boolean)) return true;
  if ([...byAttempt.values()].every(f => !f)) return false;
  return undefined;
}

interface ScorerSide {
  byItem: Map<string, number>;
  /** item -> number of valid scores from attempts that did not fail */
  validCount: Map<string, number>;
  /** Any finite score at all for this scorer (before excluding failed runs). */
  ran: boolean;
  invalid: number;
  unattributed: number;
}

function scorerSide(rows: ScoreRow[], scorerId: string, run: RunIndex, dropFailed: boolean): ScorerSide {
  const acc = new Map<string, number[]>();
  const validCount = new Map<string, number>();
  let ran = false, invalid = 0, unattributed = 0;
  for (const r of rows) {
    if (r.scorerId !== scorerId || r.score === null || r.score === undefined) continue;
    if (!Number.isFinite(r.score)) {
      invalid++;
      continue;
    }
    ran = true;
    const failed = scoreFromFailedRun(r, run);
    if (failed === undefined && run.has(r.entityId)) unattributed++;
    if (!failed) validCount.set(r.entityId, (validCount.get(r.entityId) ?? 0) + 1);
    if (dropFailed && failed) continue;
    const list = acc.get(r.entityId) ?? [];
    list.push(r.score);
    acc.set(r.entityId, list);
  }
  return { byItem: new Map([...acc].map(([item, xs]) => [item, mean(xs)])), validCount, ran, invalid, unattributed };
}

/** A short, readable form of a result row's error (Mastra stores { message, stack } or a string). */
export function errorMessage(e: unknown): string | undefined {
  if (e === null || e === undefined) return undefined;
  const raw =
    typeof e === 'string'
      ? e
      : typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
        ? (e as { message: string }).message
        : JSON.stringify(e);
  const one = (raw ?? '').replace(/\s+/g, ' ').trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

const failureRate = (byAttempt: Map<number, boolean>) => [...byAttempt.values()].filter(Boolean).length / byAttempt.size;

function missingReason(item: string, run: RunIndex): MissingReason {
  const byAttempt = run.get(item);
  if (!byAttempt) return 'not-run';
  return [...byAttempt.values()].every(Boolean) ? 'target-error' : 'no-score';
}

/** Per-item changes, or their per-cluster means when items are clustered (unmapped items are their own cluster). */
function clusterChanges(itemIds: string[], change: (itemId: string) => number, clusters?: Record<string, string>): number[] {
  if (!clusters) return itemIds.map(change);
  const byCluster = new Map<string, number[]>();
  for (const i of itemIds) {
    // Separate namespaces, so a cluster id can never collide with an unclustered item's id.
    const c = Object.hasOwn(clusters, i) ? `c\u0000${clusters[i]}` : `i\u0000${i}`;
    (byCluster.get(c) ?? byCluster.set(c, []).get(c)!).push(change(i));
  }
  return [...byCluster.keys()].sort().map(c => mean(byCluster.get(c)!));
}

const emptyReasons = (): Record<MissingReason, number> => ({ 'target-error': 0, 'no-score': 0, 'not-run': 0 });

/** Attempts of run k are renumbered k * RUN_STRIDE + attempt; attempts must be integers below it. */
const RUN_STRIDE = 2 ** 32;

/**
 * A score with no attempt number, attributed within its own run: to the item's only result row, or
 * to a failed attempt when every attempt of the item in that run failed, or to the first attempt when
 * none did. Left unknown when the run's attempts for that item both failed and succeeded.
 */
function attributeAttempt(sc: ScoreRow, attemptsByItem: Map<string, Array<{ attempt: number; failed: boolean }>>): number | null {
  if (sc.attempt !== null && sc.attempt !== undefined) return sc.attempt;
  const attempts = attemptsByItem.get(sc.entityId);
  if (!attempts || attempts.length === 0) return null;
  if (attempts.length === 1) return attempts[0]!.attempt;
  if (attempts.every(a => a.failed)) return attempts[0]!.attempt;
  if (attempts.every(a => !a.failed)) return attempts[0]!.attempt;
  return null;
}

/** Several runs of the same dataset as one experiment, with attempts renumbered per run. */
function mergeRuns(runs: ExperimentRows[]): ExperimentRows {
  for (const run of runs) {
    for (const r of [...run.results, ...run.scores]) {
      const a = r.attempt;
      if (a !== null && a !== undefined && !(Number.isInteger(a) && a >= 0 && a < RUN_STRIDE)) {
        throw new TypeError(`attempt numbers must be integers from 0 to ${RUN_STRIDE - 1} (got ${a} in ${run.id})`);
      }
    }
  }
  if (runs.length === 1) return runs[0]!;
  const results: ResultRow[] = [];
  const scores: ScoreRow[] = [];
  runs.forEach((run, k) => {
    const attemptsByItem = new Map<string, Array<{ attempt: number; failed: boolean }>>();
    for (const r of run.results) {
      results.push({ ...r, attempt: k * RUN_STRIDE + (r.attempt ?? 0) });
      (attemptsByItem.get(r.itemId) ?? attemptsByItem.set(r.itemId, []).get(r.itemId)!).push({ attempt: r.attempt ?? 0, failed: isFailed(r) });
    }
    for (const sc of run.scores) {
      const attempt = attributeAttempt(sc, attemptsByItem);
      scores.push({ ...sc, attempt: attempt === null ? null : k * RUN_STRIDE + attempt });
    }
  });
  return { id: runs.map(r => r.id).join('+'), results, scores, status: runs.every(r => r.status === 'completed' || r.status == null) ? 'completed' : 'mixed' };
}

/** Per item: mean of a numeric field over successful attempts (non-negative finite values only). */
function perItem(results: ResultRow[], field: 'durationMs' | 'tokens'): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const r of results) {
    const v = r[field];
    if (isFailed(r) || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    (acc.get(r.itemId) ?? acc.set(r.itemId, []).get(r.itemId)!).push(v);
  }
  return new Map([...acc].map(([i, xs]) => [i, mean(xs)]));
}

export function compareRows(
  baselineIn: ExperimentRows | ExperimentRows[],
  candidateIn: ExperimentRows | ExperimentRows[],
  options: CompareOptions = {},
): Comparison {
  validateOptions(options);
  const baselineRuns = Array.isArray(baselineIn) ? baselineIn : [baselineIn];
  const candidateRuns = Array.isArray(candidateIn) ? candidateIn : [candidateIn];
  if (baselineRuns.length === 0 || candidateRuns.length === 0) throw new TypeError('compareRows needs at least one baseline and one candidate run');
  const baseline = mergeRuns(baselineRuns);
  const candidate = mergeRuns(candidateRuns);
  const {
    thresholds = {},
    test = 'sign-flip',
    scoreBounds = {},
    latency,
    tokens,
    expectedScorers = [],
    alpha = 0.05,
    reliability: reliabilityMode = 'strict',
    clusters,
    maxNewTargetFailures = 0,
    maxCoverageLoss = 0,
    allowSubset = false,
    requireCompleted = true,
    seed = 1,
    resamples = 20000,
    includeScoresOfFailedRuns = false,
    midP = false,
    itemDetail = 10,
  } = options;
  const warnings: string[] = [];
  const reasons: GateReason[] = [];
  const items: ItemDetail[] = [];
  const insufficient = (kind: GateReason['kind'], message: string, scorerId?: string) =>
    reasons.push({ kind, severity: 'insufficient', message, ...(scorerId ? { scorerId } : {}) });
  const fail = (kind: GateReason['kind'], message: string, scorerId?: string) =>
    reasons.push({ kind, severity: 'fail', message, ...(scorerId ? { scorerId } : {}) });

  // The runs themselves
  for (const [label, runs] of [['baseline', baselineRuns], ['candidate', candidateRuns]] as const) {
    for (const run of runs) {
      if (requireCompleted && run.status && run.status !== 'completed') {
        insufficient('incomplete', `The ${label} experiment ${run.id} has status "${run.status}", not "completed".`);
      }
      if (run.results.length === 0) insufficient('no-evidence', `The ${label} experiment ${run.id} has no results.`);
    }
  }
  if (test === 'betting' && baselineRuns.length !== candidateRuns.length) {
    insufficient('no-evidence', `The betting test pairs runs in order and needs as many baseline runs as candidate runs (${baselineRuns.length} vs ${candidateRuns.length}).`);
  }
  if (baseline.datasetVersion != null && candidate.datasetVersion != null && baseline.datasetVersion !== candidate.datasetVersion) {
    warnings.push(`Dataset versions differ (${baseline.datasetVersion} vs ${candidate.datasetVersion}); items with the same id may have changed.`);
  }

  const runA = indexRun(baseline.results);
  const runB = indexRun(candidate.results);

  // Reliability: per item failure rate, gross increase
  let failedA = 0, failedB = 0, newFailures = 0, fixedFailures = 0, both = 0, excess = 0;
  let singleAttempts = true;
  let worse = 0, better = 0;
  const rateChanges: number[] = []; // fA - fB per shared item: negative = more failures
  for (const [item, attemptsA] of runA) {
    const attemptsB = runB.get(item);
    if (!attemptsB) continue;
    both++;
    const fa = failureRate(attemptsA), fb = failureRate(attemptsB);
    rateChanges.push(fa - fb);
    if (fa > 0) failedA++;
    if (fb > 0) failedB++;
    if (fb > fa) {
      newFailures++;
      excess += fb - fa;
      const failed = candidate.results.find(r => r.itemId === item && isFailed(r));
      const error = errorMessage(failed?.error);
      items.push({ itemId: item, kind: 'new-failure', baseline: fa, candidate: fb, ...(error ? { error } : {}) });
    }
    if (fa > fb) fixedFailures++;
    if (attemptsA.size !== 1 || attemptsB.size !== 1) singleAttempts = false;
    else if (fb > fa) worse++;
    else if (fa > fb) better++;
  }
  const onlyA = [...runA.keys()].filter(i => !runB.has(i)).length;
  const onlyB = [...runB.keys()].filter(i => !runA.has(i)).length;
  const failedOnlyB = [...runB].filter(([i, attempts]) => !runA.has(i) && [...attempts.values()].some(Boolean)).length;
  if (failedOnlyB > 0) warnings.push(`${failedOnlyB} item(s) only in the candidate had failed runs; reliability compares shared items only.`);
  if (onlyA || onlyB) warnings.push(`Item sets differ: ${onlyA} only in baseline, ${onlyB} only in candidate. Scores are compared on shared items only.`);
  if (onlyA > 0 && !allowSubset) {
    insufficient('coverage', `The candidate did not run ${onlyA} of the baseline's ${runA.size} item(s), so nothing is known about them (allowSubset to accept).`);
  }
  // One-sided p for "more failures": exact McNemar for single attempts, the same sign-flip on rates otherwise.
  const reliabilityP = singleAttempts ? mcnemarExactPValue(worse, better) : rateChanges.length ? signFlipPValue(rateChanges, 0, { seed, resamples }) : 1;
  const overBudget = excess > maxNewTargetFailures + 1e-9;
  const reliability: ReliabilityReport = {
    items: both,
    failedA,
    failedB,
    newFailures,
    fixedFailures,
    excessFailures: excess,
    pValue: reliabilityP,
    regressed: overBudget && (reliabilityMode === 'strict' || reliabilityP < alpha),
  };
  if (overBudget && !reliability.regressed) {
    warnings.push(`${newFailures} item(s) fail more often in the candidate (${fixedFailures} less often), not significant (p = ${fmt(reliabilityP)}) under reliability: 'statistical'.`);
  }
  if (reliability.regressed) {
    fail(
      'reliability',
      (singleAttempts
        ? `${newFailures} item(s) fail in the candidate that passed in the baseline; allowed ${maxNewTargetFailures} (${fixedFailures} fixed, which do not offset).`
        : `Failure rate rose on ${newFailures} item(s), ${excess.toFixed(2)} extra failed runs per item-attempt set; allowed ${maxNewTargetFailures}.`) +
        ` p = ${fmt(reliabilityP)}${reliabilityMode === 'strict' ? " (reliability: 'strict' fails on any excess)" : ''}.`,
    );
  }

  // Scorers
  const scorerIds = [...new Set([...baseline.scores, ...candidate.scores].map(s => s.scorerId).concat(expectedScorers))].sort();
  if (scorerIds.length === 0) insufficient('no-evidence', 'No scores in either experiment, so there is nothing to compare.');
  const reports: ScorerReport[] = [];
  const sideOf: Record<string, { a: Map<string, number>; b: Map<string, number> }> = {};
  const coverageOf: Record<string, number> = {};
  const outOfBoundsScorers = new Set<string>();
  const bettingEmpty = new Set<string>();
  for (const scorerId of scorerIds) {
    const threshold = (Object.hasOwn(thresholds, scorerId) ? thresholds[scorerId] : undefined) ?? { value: 0 };
    const direction: Direction = threshold.direction ?? 'higher-is-better';
    const sign = direction === 'higher-is-better' ? 1 : -1;
    const sideA = scorerSide(baseline.scores, scorerId, runA, !includeScoresOfFailedRuns);
    const sideB = scorerSide(candidate.scores, scorerId, runB, !includeScoresOfFailedRuns);
    const a = sideA.byItem, b = sideB.byItem;
    sideOf[scorerId] = { a, b };
    if (sideA.invalid) warnings.push(`"${scorerId}": ${sideA.invalid} non-finite score(s) in the baseline were ignored.`);
    if (sideB.invalid) warnings.push(`"${scorerId}": ${sideB.invalid} non-finite score(s) in the candidate were ignored.`);
    if (sideA.unattributed + sideB.unattributed > 0) {
      insufficient(
        'coverage',
        `"${scorerId}": ${sideA.unattributed + sideB.unattributed} score(s) could not be matched to an attempt on items where some attempts failed, so a failed run's score could be counted; record score attempts.`,
        scorerId,
      );
    }
    const paired = [...a.keys()].filter(i => b.has(i)).sort();
    const changes = clusterChanges(paired, i => sign * (b.get(i)! - a.get(i)!), clusters);
    const lostInB = emptyReasons(), lostInA = emptyReasons();
    for (const i of a.keys()) if (!b.has(i)) lostInB[missingReason(i, runB)]++;
    for (const i of b.keys()) if (!a.has(i)) lostInA[missingReason(i, runA)]++;
    const status: ScorerReport['status'] = !sideA.ran ? 'missing-in-baseline' : !sideB.ran ? 'missing-in-candidate' : 'ok';
    const n = changes.length;
    const bounds = (Object.hasOwn(scoreBounds, scorerId) ? scoreBounds[scorerId] : undefined) ?? { min: 0, max: 1 };
    let p: number;
    if (status !== 'ok' || n === 0) p = Number.NaN;
    else if (test === 'betting') {
      // Observations in a fixed order: run pair by run pair, items sorted by id.
      const outOfBounds = [...baseline.scores, ...candidate.scores].some(
        x => x.scorerId === scorerId && Number.isFinite(x.score) && ((x.score as number) < bounds.min || (x.score as number) > bounds.max),
      );
      if (outOfBounds) {
        outOfBoundsScorers.add(scorerId);
        p = Number.NaN;
      } else {
        // Observations run pair by run pair, each in a seeded random order chosen without looking at
        // the data (a fixed order such as sorted ids can line up with item difficulty).
        const obs: number[] = [];
        if (baselineRuns.length === candidateRuns.length) {
          for (let k = 0; k < baselineRuns.length; k++) {
            const ra = indexRun(baselineRuns[k]!.results), rb = indexRun(candidateRuns[k]!.results);
            const ak = scorerSide(baselineRuns[k]!.scores, scorerId, ra, !includeScoresOfFailedRuns).byItem;
            const bk = scorerSide(candidateRuns[k]!.scores, scorerId, rb, !includeScoresOfFailedRuns).byItem;
            const shared = [...ak.keys()].filter(i => bk.has(i)).sort();
            const units = clusterChanges(shared, i => sign * (bk.get(i)! - ak.get(i)!), clusters);
            const u = rng(seed * 1009 + k);
            const order = units.map((x, i) => [u(), i, x] as const).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
            obs.push(...order.map(([, , x]) => x));
          }
        }
        if (obs.length === 0) {
          bettingEmpty.add(scorerId);
          p = Number.NaN;
        } else {
          const range = bounds.max - bounds.min;
          p = bettingPValue(obs, threshold.value, { lower: -range, upper: range, alpha });
        }
      }
    } else p = signFlipPValue(changes, threshold.value, { seed, resamples, midP });
    // Coverage per successful attempt, relative to the baseline
    let coverageLoss = 0;
    for (const [item, attemptsA] of runA) {
      const attemptsB = runB.get(item);
      if (!attemptsB) continue;
      const okA = [...attemptsA.values()].filter(f => !f).length, okB = [...attemptsB.values()].filter(f => !f).length;
      if (okA === 0 || okB === 0) continue;
      const covA = Math.min(1, (sideA.validCount.get(item) ?? 0) / okA), covB = Math.min(1, (sideB.validCount.get(item) ?? 0) / okB);
      if (covB < covA) coverageLoss += covA - covB;
    }
    coverageOf[scorerId] = coverageLoss;
    reports.push({
      scorerId,
      test,
      direction,
      tolerance: threshold.value,
      status,
      pairedN: paired.length,
      testUnits: n,
      meanA: mean(paired.map(i => a.get(i)!)),
      meanB: mean(paired.map(i => b.get(i)!)),
      change: mean(changes),
      changeCI: bootstrapMeanCI(changes, { seed, resamples: Math.min(5000, resamples) }),
      pValue: p,
      pAdjusted: Number.NaN,
      minimumDetectable: Number.NaN,
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
    });
  }

  const compared = reports.filter(r => r.status === 'ok' && r.pairedN > 0);
  const perTestAlpha = alpha / Math.max(1, compared.length); // Holm's worst case
  const adjusted = holm(reports.map(r => r.pValue));
  reports.forEach((r, k) => {
    r.pAdjusted = adjusted[k]!;
    if (r.status === 'missing-in-candidate') {
      fail('missing-scorer', `Scorer "${r.scorerId}" has scores in the baseline but none in the candidate.`, r.scorerId);
      return;
    }
    if (r.status === 'missing-in-baseline') {
      if (expectedScorers.includes(r.scorerId)) insufficient('missing-scorer', `Expected scorer "${r.scorerId}" has no scores in the baseline.`, r.scorerId);
      else warnings.push(`Scorer "${r.scorerId}" has no scores in the baseline; nothing to compare it with.`);
      return;
    }
    if (r.pairedN === 0) {
      insufficient('no-evidence', `"${r.scorerId}" has no item scored in both experiments.`, r.scorerId);
      return;
    }
    if (bettingEmpty.has(r.scorerId)) {
      insufficient('no-evidence', `"${r.scorerId}": no item was scored in both runs of any run pair, so the betting test has nothing to use.`, r.scorerId);
      return;
    }
    if (outOfBoundsScorers.has(r.scorerId)) {
      insufficient('no-evidence', `"${r.scorerId}" has scores outside scoreBounds, which the betting test needs; declare its range.`, r.scorerId);
      return;
    }
    if (![r.meanA, r.meanB, r.change].every(Number.isFinite)) {
      insufficient('no-evidence', `"${r.scorerId}": scores are too large to average (the mean overflows).`, r.scorerId);
      return;
    }
    const changes = (() => {
      const { a, b } = sideOf[r.scorerId]!;
      const sign = r.direction === 'higher-is-better' ? 1 : -1;
      return clusterChanges([...a.keys()].filter(i => b.has(i)).sort(), i => sign * (b.get(i)! - a.get(i)!), clusters);
    })();
    const units = changes.length; // clusters when clustered, items otherwise
    // The normal approximation describes the sign-flip test; the betting test needs more data, so no estimate.
    r.minimumDetectable = r.test === 'betting' ? Number.NaN : minimumDetectableEffect(sd(changes), units, perTestAlpha, 0.8, r.tolerance);
    // Tolerate float noise when the drop equals the tolerance exactly.
    const eps = 1e-9 * Math.max(1, Math.abs(r.tolerance), Math.abs(r.meanA), Math.abs(r.meanB));
    const beyond = r.change < -r.tolerance - eps;
    r.regressed = beyond && r.pAdjusted < alpha;
    r.inconclusive = beyond && !r.regressed;
    if (r.regressed) {
      fail(
        'regression',
        `"${r.scorerId}" is worse by ${fmt(-r.change)} on ${r.pairedN} paired items (95% CI of change ${fmt(r.changeCI[0])} to ${fmt(r.changeCI[1])}; Holm p = ${fmt(r.pAdjusted)}).`,
        r.scorerId,
      );
    } else if (r.test === 'sign-flip' && smallestSignFlipP(units) >= perTestAlpha) {
      const unit = clusters ? 'cluster(s)' : 'paired item(s)';
      insufficient(
        'too-few-items',
        `"${r.scorerId}": ${units} ${unit} can never reach significance at this level; at least ${minimumItemsForAlpha(perTestAlpha)} are needed${compared.length > 1 ? ` with ${compared.length} scorers` : ''}.`,
        r.scorerId,
      );
    } else if (r.inconclusive) {
      const detect = Number.isFinite(r.minimumDetectable) ? `; a drop of about ${fmt(r.minimumDetectable)} would be caught 80% of the time` : '';
      const more =
        r.test === 'betting'
          ? ' The betting test stays valid if you run both again and pass all runs, but it gathers evidence slowly; for power, prefer more runs with the sign-flip test.'
          : '';
      warnings.push(`"${r.scorerId}" looks worse by ${fmt(-r.change)} but that is not significant at n = ${r.pairedN} (Holm p = ${fmt(r.pAdjusted)})${detect}.${more}`);
    }
    const coverageLoss = coverageOf[r.scorerId] ?? 0;
    if (coverageLoss > maxCoverageLoss + 1e-9) {
      insufficient(
        'coverage',
        `"${r.scorerId}" lost valid scores the baseline had on successful runs (scorer error, skipped, or non-finite): ${fmt(coverageLoss)} item-equivalents, ${r.lostInB['no-score']} whole item(s); allowed ${maxCoverageLoss}. Re-run the scorer before trusting this comparison.`,
        r.scorerId,
      );
    }
    // A higher-is-better scorer at its floor on every item in both experiments cannot show a change.
    // Seen in the field: Mastra's prebuilt agent judges, put on a workflow target, receive empty
    // input and output and score 0 everywhere, without an error.
    const { a: floorA, b: floorB } = sideOf[r.scorerId]!;
    const floor = ((Object.hasOwn(scoreBounds, r.scorerId) ? scoreBounds[r.scorerId] : undefined) ?? { min: 0, max: 1 }).min;
    const allScores = [...floorA.values(), ...floorB.values()];
    if (r.direction === 'higher-is-better' && r.pairedN >= 5 && allScores.every(x => x === floor)) {
      warnings.push(
        `"${r.scorerId}" scored ${floor} on every item in both experiments, so it cannot show a change. Check that it can read this target's output (Mastra's prebuilt agent judges score a workflow's output as empty).`,
      );
    }
    if (r.lostInB['target-error'] > 0) {
      warnings.push(`"${r.scorerId}": ${r.lostInB['target-error']} item(s) scored in the baseline have no score in the candidate because the target failed; they are excluded from the paired mean and counted under reliability.`);
    }
    // Item detail: the largest drops, and scores lost to the scorer
    const { a, b } = sideOf[r.scorerId]!;
    const sign = r.direction === 'higher-is-better' ? 1 : -1;
    for (const i of a.keys()) {
      if (b.has(i)) {
        const delta = sign * (b.get(i)! - a.get(i)!);
        if (delta < 0) items.push({ itemId: i, scorerId: r.scorerId, kind: 'drop', baseline: a.get(i)!, candidate: b.get(i)! });
      } else if (missingReason(i, runB) === 'no-score') {
        items.push({ itemId: i, scorerId: r.scorerId, kind: 'lost-score', baseline: a.get(i)!, candidate: null });
      }
    }
  });

  // Items that scored lower in every candidate run than in every baseline run. The average can miss
  // a regression concentrated on a few items (3 changed items can never reach p < 1/8), so these are
  // named even when the quality test is not significant.
  if (baselineRuns.length >= 2 && candidateRuns.length >= 2) {
    for (const r of reports) {
      if (r.status !== 'ok') continue;
      const sign = r.direction === 'higher-is-better' ? 1 : -1;
      const perRun = (runs: ExperimentRows[]) =>
        runs.map(run => scorerSide(run.scores, r.scorerId, indexRun(run.results), !includeScoresOfFailedRuns).byItem);
      const a = perRun(baselineRuns), b = perRun(candidateRuns);
      const shared = [...a[0]!.keys()].filter(i => a.every(m => m.has(i)) && b.every(m => m.has(i))).sort();
      const consistent = shared.filter(i => Math.max(...b.map(m => sign * m.get(i)!)) < Math.min(...a.map(m => sign * m.get(i)!)));
      if (consistent.length > 0) {
        warnings.push(
          `"${r.scorerId}": ${consistent.length} item(s) scored lower in every one of ${candidateRuns.length} candidate runs than in every one of ${baselineRuns.length} baseline runs, a consistent change the average can't show; review them (listed under Items).`,
        );
        for (const i of consistent) {
          items.push({ itemId: i, scorerId: r.scorerId, kind: 'consistent-drop', baseline: mean(a.map(m => m.get(i)!)), candidate: mean(b.map(m => m.get(i)!)) });
        }
      }
    }
  }

  // Run time and token use
  const resources: Comparison['resources'] = {};
  for (const [key, field, opt] of [['latency', 'durationMs', latency], ['tokens', 'tokens', tokens]] as const) {
    const a = perItem(baseline.results, field), b = perItem(candidate.results, field);
    const shared = [...a.keys()].filter(i => b.has(i)).sort();
    const label = key === 'latency' ? 'Run time' : 'Token use';
    if (opt) {
      // A requested check needs a measurement for every item that succeeded in both runs.
      const succeededBoth = [...runA.keys()].filter(i => runB.has(i) && [...runA.get(i)!.values()].some(f => !f) && [...runB.get(i)!.values()].some(f => !f));
      const missing = succeededBoth.filter(i => !a.has(i) || !b.has(i)).length;
      if (succeededBoth.length === 0 || missing > 0) {
        insufficient('no-evidence', `${label} check requested, but ${missing || 'all'} of ${succeededBoth.length} item(s) that succeeded in both runs have no valid measurement (missing, negative or non-finite).`);
        continue;
      }
    }
    if (shared.length === 0) continue;
    // +1 so zero values (cached calls, instant runs) compare instead of dividing by zero.
    const logRatios = shared.map(i => Math.log((b.get(i)! + 1) / (a.get(i)! + 1)));
    const allowed = opt?.maxIncrease ?? 0;
    // Negative = worse, like quality changes, so the same one-sided test applies.
    const pv = signFlipPValue(logRatios.map(x => -x), Math.log(1 + allowed), { seed, resamples });
    const ratio = Math.exp(mean(logRatios));
    const report: ResourceReport = { items: shared.length, ratio, pValue: pv, maxIncrease: opt ? allowed : null, regressed: false };
    if (opt) {
      report.regressed = ratio > 1 + allowed && pv < alpha;
      if (report.regressed) fail(key === 'latency' ? 'latency' : 'cost', `${label} per item rose ${fmt((ratio - 1) * 100)}% (geometric mean over ${shared.length} items; allowed ${fmt(allowed * 100)}%; p = ${fmt(pv)}).`);
    } else if (ratio > 1.2 && pv < alpha) {
      warnings.push(`${label} per item rose ${fmt((ratio - 1) * 100)}% (p = ${fmt(pv)}); set \`${key}: { maxIncrease }\` to gate on it.`);
    }
    resources[key] = report;
  }

  // A verdict needs at least one scorer actually compared.
  const comparable = reports.some(r => r.status === 'ok' && r.pairedN > 0 && [r.meanA, r.meanB, r.change].every(Number.isFinite));
  if (scorerIds.length > 0 && !comparable) {
    insufficient('no-evidence', 'No scorer has valid scores in both experiments on shared items, so nothing was compared.');
  }

  const kindOrder = { 'new-failure': 0, 'consistent-drop': 1, 'lost-score': 2, drop: 3 } as const;
  const size = (d: ItemDetail) => (d.kind === 'drop' ? Math.abs((d.candidate ?? 0) - (d.baseline ?? 0)) : 1);
  items.sort((x, y) => kindOrder[x.kind] - kindOrder[y.kind] || size(y) - size(x) || x.itemId.localeCompare(y.itemId));
  const seen = new Set<string>();
  const unique = items.filter(d => {
    const key = `${d.itemId} ${d.scorerId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const verdict: Verdict = reasons.some(r => r.severity === 'fail') ? 'fail' : reasons.length > 0 ? 'insufficient' : 'pass';
  return {
    baselineId: baseline.id,
    candidateId: candidate.id,
    runs: { baseline: baselineRuns.length, candidate: candidateRuns.length },
    resources,
    verdict,
    passed: verdict === 'pass',
    reasons,
    warnings,
    reliability,
    scorers: Object.fromEntries(reports.map(r => [r.scorerId, r])),
    items: unique.slice(0, itemDetail),
  };
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  return Math.abs(x) >= 0.001 || x === 0 ? x.toFixed(3) : x.toExponential(1);
}
