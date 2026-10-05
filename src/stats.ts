/**
 * Small, dependency-free statistics for paired experiment comparison.
 *
 * Everything that uses randomness takes a seed so results are reproducible.
 */

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Largest n for which the sign-flip test enumerates all 2^n sign patterns. */
export const EXACT_SIGN_FLIP_MAX_N = 16;

/**
 * One-sided paired sign-flip (permutation) test.
 *
 * `diffs` are signed so that negative means "worse". Tests
 *   H0: the diffs are symmetric about -tolerance (no regression beyond tolerance)
 *   H1: they are shifted below -tolerance (a regression beyond tolerance).
 * Returns the p-value P(mean of sign-flipped shifted diffs <= observed). Exact for
 * n <= EXACT_SIGN_FLIP_MAX_N, Monte Carlo with `resamples` draws otherwise.
 * With `midP`, ties with the observed sum count half (less conservative on discrete scores).
 */
export function signFlipPValue(
  diffs: readonly number[],
  tolerance = 0,
  { resamples = 20000, seed = 1, midP = false }: { resamples?: number; seed?: number; midP?: boolean } = {},
): number {
  const n = diffs.length;
  if (n === 0) return Number.NaN;
  const e = diffs.map(d => d + tolerance);
  const observed = e.reduce((a, b) => a + b, 0);
  const abs = e.map(Math.abs);
  // Tolerate float noise when comparing sums.
  const eps = 1e-12 * Math.max(1, abs.reduce((a, b) => a + b, 0));

  if (n <= EXACT_SIGN_FLIP_MAX_N) {
    const total = 1 << n;
    let below = 0, tied = 0;
    for (let mask = 0; mask < total; mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += mask & (1 << i) ? -abs[i]! : abs[i]!;
      if (s < observed - eps) below++;
      else if (s <= observed + eps) tied++;
    }
    return (below + (midP ? 0.5 : 1) * tied) / total;
  }

  const u = rng(seed);
  let below = 0, tied = 0;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += u() < 0.5 ? -abs[i]! : abs[i]!;
    if (s < observed - eps) below++;
    else if (s <= observed + eps) tied++;
  }
  return (below + (midP ? 0.5 : 1) * tied + 1) / (resamples + 1);
}

/** Smallest p-value the exact sign-flip tests can return with n non-zero differences. */
export const smallestSignFlipP = (n: number) => 2 ** -n;

/** Fewest non-zero paired differences for which a sign-flip test can reach p < alpha. */
export const minimumItemsForAlpha = (alpha: number) => Math.floor(Math.log2(1 / alpha)) + 1;

/** Percentile bootstrap interval for the mean of `xs`. */
export function bootstrapMeanCI(
  xs: readonly number[],
  { level = 0.95, resamples = 5000, seed = 1 }: { level?: number; resamples?: number; seed?: number } = {},
): [number, number] {
  const n = xs.length;
  if (n === 0) return [Number.NaN, Number.NaN];
  if (n === 1) return [xs[0]!, xs[0]!];
  const u = rng(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(u() * n)]!;
    means[r] = s / n;
  }
  means.sort();
  const lo = (1 - level) / 2;
  const at = (q: number) => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))]!;
  return [at(lo), at(1 - lo)];
}

/** log of n choose k. */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}

/**
 * Exact one-sided McNemar test on discordant pairs.
 * `worse` = pairs that went from ok to bad, `better` = bad to ok.
 * Returns P(X >= worse) for X ~ Binomial(worse + better, 0.5).
 */
export function mcnemarExactPValue(worse: number, better: number): number {
  const n = worse + better;
  if (n === 0) return 1;
  let p = 0;
  for (let k = worse; k <= n; k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, p);
}

/** Holm step-down adjustment. Returns adjusted p-values in the input order. */
export function holm(pValues: readonly number[]): number[] {
  const order = pValues.map((p, i) => [p, i] as const).filter(([p]) => !Number.isNaN(p));
  order.sort((a, b) => a[0] - b[0]);
  const out = pValues.map(p => (Number.isNaN(p) ? Number.NaN : 1));
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (order.length - rank) * p));
    out[i] = running;
  });
  return out;
}

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0, 1)');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155211639];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - plow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Approximate smallest true drop the gate would flag with the given power: the tolerance plus
 * (z_{1-alpha} + z_{power}) * sd(diffs) / sqrt(n), where `alpha` should already be the per-test
 * level (e.g. alpha / number of scorers, Holm's worst case). A normal approximation that uses the
 * observed SD; NaN when it can't be estimated (n < 2 or SD 0), Infinity when n is too small for
 * the exact test to reach `alpha` at all.
 */
export function minimumDetectableEffect(diffSd: number, n: number, alpha = 0.05, power = 0.8, tolerance = 0): number {
  if (n > 0 && smallestSignFlipP(n) >= alpha) return Number.POSITIVE_INFINITY;
  if (n < 2 || !Number.isFinite(diffSd) || diffSd === 0) return Number.NaN;
  return tolerance + ((normalQuantile(1 - alpha) + normalQuantile(power)) * diffSd) / Math.sqrt(n);
}
