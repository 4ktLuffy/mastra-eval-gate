/**
 * M1: false-alarm rate and detection power of Mastra's compareExperiments rule vs the gate's
 * paired test, by simulation. No assumptions are taken on faith: every rate here is counted.
 *
 * Model: item difficulty mu_i ~ U(0.2, 0.9). System S scores item i as
 *   continuous: clip(mu_i + effect_S + N(0, sigma))      (sigma = judge + agent noise)
 *   3-level:    the continuous score rounded to {0, 0.5, 1}
 *   binary:     Bernoulli(clip(mu_i + effect_S))
 * Baseline effect 0; candidate effect -d (a true regression of size d, before clipping/rounding).
 * Old rule (compare.ts): mean(B) - mean(A) < -tolerance, unpaired.
 * Gate rule: paired change < -tolerance AND one-sided sign-flip p < alpha.
 * Calibrated unpaired rule (fair comparison): the old unpaired delta, but with a cut-off chosen
 * from the null simulation so that it also has a 5% false-alarm rate at effect = tolerance.
 *
 * Run: npx tsx bench/power.ts  (writes results/power.json and results/power.md)
 */
import { writeFileSync } from 'node:fs';
import { mean, rng, signFlipPValue } from '../src/stats.js';

const TRIALS = 2000;
const ALPHA = 0.05;
const NS = [10, 20, 50];
const TOLERANCES = [0, 0.05, 0.1];
const EFFECTS = [0, 0.05, 0.1, 0.2];
const MODELS = ['continuous σ=0.1', 'continuous σ=0.2', '3-level σ=0.2', 'binary'] as const;
type Model = (typeof MODELS)[number];

const clip = (x: number) => Math.min(1, Math.max(0, x));
function gauss(u: () => number) {
  const a = Math.max(u(), 1e-12), b = u();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}
function score(model: Model, mu: number, effect: number, u: () => number) {
  switch (model) {
    case 'continuous σ=0.1': return clip(mu + effect + 0.1 * gauss(u));
    case 'continuous σ=0.2': return clip(mu + effect + 0.2 * gauss(u));
    case '3-level σ=0.2': return Math.round(clip(mu + effect + 0.2 * gauss(u)) * 2) / 2;
    case 'binary': return u() < clip(mu + effect) ? 1 : 0;
  }
}

type Row = { model: Model; n: number; tolerance: number; effect: number; oldRate: number; gateRate: number; calibratedRate: number; gateMidPRate: number };
const rows: Row[] = [];
const deltas = new Map<string, number[]>();
let seed = 12345;
for (const model of MODELS)
  for (const n of NS)
    for (const tolerance of TOLERANCES)
      for (const effect of EFFECTS) {
        const u = rng(seed++);
        let oldHits = 0, gateHits = 0, midHits = 0;
        const unpairedDeltas: number[] = [];
        for (let t = 0; t < TRIALS; t++) {
          const mu = Array.from({ length: n }, () => 0.2 + 0.7 * u());
          const a = mu.map(m => score(model, m, 0, u));
          const b = mu.map(m => score(model, m, -effect, u));
          const unpaired = mean(b) - mean(a);
          unpairedDeltas.push(unpaired);
          if (unpaired < -tolerance) oldHits++;
          const diffs = b.map((x, i) => x - a[i]!);
          if (mean(diffs) < -tolerance) {
            if (signFlipPValue(diffs, tolerance, { resamples: 1000, seed: t + 1 }) < ALPHA) gateHits++;
            if (signFlipPValue(diffs, tolerance, { resamples: 1000, seed: t + 1, midP: true }) < ALPHA) midHits++;
          }
        }
        rows.push({ model, n, tolerance, effect, oldRate: oldHits / TRIALS, gateRate: gateHits / TRIALS, calibratedRate: Number.NaN, gateMidPRate: midHits / TRIALS });
        deltas.set(`${model}|${n}|${tolerance}|${effect}`, unpairedDeltas);
      }

// Calibrate the unpaired cut-off on the boundary null (true change = -tolerance, i.e. effect = tolerance;
// for tolerance 0 that is effect 0). Only tolerances that are also simulated effects can be calibrated.
for (const r of rows) {
  const nullKey = `${r.model}|${r.n}|${r.tolerance}|${r.tolerance}`;
  const nul = deltas.get(nullKey);
  if (!nul) continue;
  const cut = [...nul].sort((x, y) => x - y)[Math.floor(ALPHA * nul.length)]!;
  const d = deltas.get(`${r.model}|${r.n}|${r.tolerance}|${r.effect}`)!;
  r.calibratedRate = d.filter(x => x < cut).length / d.length;
}

writeFileSync('results/power.json', JSON.stringify({ trials: TRIALS, alpha: ALPHA, rows }, null, 2));

// Monte Carlo standard error of a rate p over TRIALS is sqrt(p(1-p)/TRIALS) <= 0.011.
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
let md = `# M1: false alarms and detection power (simulated)\n\n${TRIALS} trials per cell, alpha ${ALPHA}. Rates are counts / ${TRIALS} (MC s.e. ≤ 1.1 pts).\n`;
md += 'Effect 0 = no real change (any flag is a false alarm). Effect d > 0 = the candidate is truly worse by d (flag = detection).\n';
md += 'An effect at or below the tolerance is not a regression by definition, so a flag there is also a false alarm.\n\n';
for (const model of MODELS) {
  md += `## ${model}\n\n| n | tolerance | effect | old rule flags | unpaired, calibrated to 5% | gate flags | gate (mid-p) flags |\n|---|---|---|---|---|---|---|\n`;
  for (const r of rows.filter(r => r.model === model)) md += `| ${r.n} | ${r.tolerance} | ${r.effect} | ${pct(r.oldRate)} | ${Number.isNaN(r.calibratedRate) ? 'n/a' : pct(r.calibratedRate)} | ${pct(r.gateRate)} | ${pct(r.gateMidPRate)} |\n`;
  md += '\n';
}
writeFileSync('results/power.md', md);
console.log('wrote results/power.json and results/power.md');
