/**
 * The whole gate, simulated: compareRows' verdict (not just the p-value function) under nulls that
 * break the quality test's assumptions, and under modest real regressions (scores and failures). Answers: how often does
 * the gate FAIL when nothing got worse, how often is it INSUFFICIENT, and how often does it catch a
 * real drop?
 *
 *   npx tsx bench/gate-sim.ts   (writes results/gate-sim.{json,md})
 *
 * Monte Carlo resamples inside the gate: 2000 (the production default is 20000; one cell is re-run
 * at 20000 at the end to show the difference). Exact tests are used for n <= 16 either way.
 */
import { writeFileSync } from 'node:fs';
import { compareRows, rng, type CompareOptions, type ExperimentRows } from '../src/index.js';

const TRIALS = Number(process.env.TRIALS ?? 1000);
const clip = (x: number) => Math.min(1, Math.max(0, x));
const gauss = (u: () => number) => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());

type Item = { a: number[]; b: number[]; failA?: boolean[]; failB?: boolean[] };
/** One trial's data: per item, attempts' scores for each scorer. */
type Trial = { scorers: string[]; items: Array<Record<string, Item>> };

function rows(id: string, t: Trial, side: 'a' | 'b'): ExperimentRows {
  const results: ExperimentRows['results'] = [];
  const scores: ExperimentRows['scores'] = [];
  t.items.forEach((byScorer, i) => {
    const first = byScorer[t.scorers[0]!]!;
    const attempts = first[side].length;
    const fails = (side === 'a' ? first.failA : first.failB) ?? Array(attempts).fill(false);
    for (let k = 0; k < attempts; k++) {
      results.push({ itemId: `i${i}`, attempt: k, error: fails[k] ? new Error('x') : null });
      if (fails[k]) continue;
      for (const s of t.scorers) scores.push({ scorerId: s, entityId: `i${i}`, score: byScorer[s]![side][k]!, attempt: k });
    }
  });
  return { id, results, scores, status: 'completed' };
}

interface Scenario {
  name: string;
  /** true drop in the candidate's mean (0 for a null) */
  drop: number;
  n: number;
  make: (u: () => number) => Trial;
  options?: CompareOptions;
}

const one = (n: number, f: (u: () => number, i: number) => Item) => (u: () => number): Trial => ({
  scorers: ['q'],
  items: Array.from({ length: n }, (_, i) => ({ q: f(u, i) })),
});

const scenarios: Scenario[] = [];
for (const n of [20, 50]) {
  // 1. Symmetric null, continuous bounded scores with item difficulty.
  scenarios.push({ name: 'symmetric null, continuous', drop: 0, n, make: one(n, u => { const mu = 0.2 + 0.6 * u(); return { a: [clip(mu + 0.15 * gauss(u))], b: [clip(mu + 0.15 * gauss(u))] }; }) });
  // 2. Codex counterexample: same mean (0.1), candidate skewed: 0 w.p. .9, 1 w.p. .1.
  scenarios.push({ name: 'skewed null (0.1 vs 0/1 at 10%)', drop: 0, n, make: one(n, u => ({ a: [0.1], b: [u() < 0.1 ? 1 : 0] })) });
  // 3. Correlated items: 5 clusters share a zero-mean shift in the candidate.
  scenarios.push({
    name: 'clustered null (5 clusters)',
    drop: 0,
    n,
    make: u => {
      const shift = Array.from({ length: 5 }, () => 0.1 * gauss(u));
      return { scorers: ['q'], items: Array.from({ length: n }, (_, i) => { const mu = 0.2 + 0.6 * u(); return { q: { a: [clip(mu + 0.1 * gauss(u))], b: [clip(mu + shift[i % 5]! + 0.1 * gauss(u))] } }; }) };
    },
  });
  // 3b. The same clustered null with the clusters declared (quality test on 5 cluster means).
  scenarios.push({
    name: 'clustered null, clusters declared',
    drop: 0,
    n,
    options: { clusters: Object.fromEntries(Array.from({ length: n }, (_, i) => [`i${i}`, `c${i % 5}`])) },
    make: u => {
      const shift = Array.from({ length: 5 }, () => 0.1 * gauss(u));
      return { scorers: ['q'], items: Array.from({ length: n }, (_, i) => { const mu = 0.2 + 0.6 * u(); return { q: { a: [clip(mu + 0.1 * gauss(u))], b: [clip(mu + shift[i % 5]! + 0.1 * gauss(u))] } }; }) };
    },
  });
  // 4. Unequal repetitions: baseline 1 attempt, candidate 3 (averaged), binary scores, same p.
  scenarios.push({ name: 'unequal repetitions null (1 vs 3, binary)', drop: 0, n, make: one(n, u => { const p = 0.2 + 0.6 * u(); return { a: [u() < p ? 1 : 0], b: [0, 1, 2].map(() => (u() < p ? 1 : 0)) }; }) });
  // 5. Three correlated scorers, null.
  scenarios.push({
    name: 'three scorers null (correlated)',
    drop: 0,
    n,
    make: u => ({
      scorers: ['s1', 's2', 's3'],
      items: Array.from({ length: n }, () => {
        const mu = 0.2 + 0.6 * u(), ea = 0.15 * gauss(u), eb = 0.15 * gauss(u);
        const mk = () => ({ a: [clip(mu + ea + 0.05 * gauss(u))], b: [clip(mu + eb + 0.05 * gauss(u))] });
        return { s1: mk(), s2: mk(), s3: mk() };
      }),
    }),
  });
  // 6. Random target failures at the same 5% rate in both runs (default budget 0).
  scenarios.push({
    name: 'random failures null (5% both runs)',
    drop: 0,
    n,
    make: one(n, u => { const mu = 0.2 + 0.6 * u(); return { a: [clip(mu + 0.15 * gauss(u))], b: [clip(mu + 0.15 * gauss(u))], failA: [u() < 0.05], failB: [u() < 0.05] }; }),
  });
  scenarios.push({
    name: 'random failures null, budget 2',
    drop: 0,
    n,
    options: { maxNewTargetFailures: 2 },
    make: one(n, u => { const mu = 0.2 + 0.6 * u(); return { a: [clip(mu + 0.15 * gauss(u))], b: [clip(mu + 0.15 * gauss(u))], failA: [u() < 0.05], failB: [u() < 0.05] }; }),
  });
  scenarios.push({
    name: "random failures null, reliability 'statistical'",
    drop: 0,
    n,
    options: { reliability: 'statistical' },
    make: one(n, u => { const mu = 0.2 + 0.6 * u(); return { a: [clip(mu + 0.15 * gauss(u))], b: [clip(mu + 0.15 * gauss(u))], failA: [u() < 0.05], failB: [u() < 0.05] }; }),
  });
  // Failures that are a real regression: 5% -> 20% of items, under both reliability modes.
  for (const mode of ['strict', 'statistical'] as const) {
    scenarios.push({
      name: `failures rise 5% -> 20%, reliability '${mode}'`,
      drop: 0.15,
      n,
      options: { reliability: mode },
      make: one(n, u => { const mu = 0.2 + 0.6 * u(); return { a: [clip(mu + 0.15 * gauss(u))], b: [clip(mu + 0.15 * gauss(u))], failA: [u() < 0.05], failB: [u() < 0.2] }; }),
    });
  }
  // Alternatives: modest drops.
  for (const d of [0.05, 0.1]) {
    scenarios.push({ name: `drop ${d}, continuous`, drop: d, n, make: one(n, u => { const mu = 0.2 + 0.6 * u(); return { a: [clip(mu + 0.15 * gauss(u))], b: [clip(mu - d + 0.15 * gauss(u))] }; }) });
    scenarios.push({ name: `drop ${d}, binary`, drop: d, n, make: one(n, u => { const p = 0.3 + 0.5 * u(); return { a: [u() < p ? 1 : 0], b: [u() < p - d ? 1 : 0] }; }) });
  }
  // Skewed alternative: candidate mean 0.05 vs 0.1 (0/1 at 5%).
  scenarios.push({ name: 'skewed drop 0.05 (0.1 vs 0/1 at 5%)', drop: 0.05, n, make: one(n, u => ({ a: [0.1], b: [u() < 0.05 ? 1 : 0] })) });
}

// The betting test on the scenarios where the choice of test matters.
const BETTING_ON = ['symmetric null, continuous', 'skewed null (0.1 vs 0/1 at 10%)', 'clustered null, clusters declared', 'drop 0.1, continuous', 'drop 0.1, binary', 'skewed drop 0.05 (0.1 vs 0/1 at 5%)'];
for (const sc of [...scenarios]) {
  if (BETTING_ON.includes(sc.name)) scenarios.push({ ...sc, name: `${sc.name} [betting]`, options: { ...sc.options, test: 'betting' } });
}

type Cell = { scenario: string; n: number; drop: number; fail: number; insufficient: number; pass: number; qualityFail: number };
const cells: Cell[] = [];
let seed = 777;
for (const sc of scenarios) {
  {
    const u = rng(seed++);
    let fail = 0, insufficient = 0, pass = 0, qualityFail = 0;
    for (let t = 0; t < TRIALS; t++) {
      const trial = sc.make(u);
      const c = compareRows(rows('A', trial, 'a'), rows('B', trial, 'b'), { resamples: 2000, seed: t + 1, allowSubset: true, ...sc.options });
      if (c.verdict === 'fail') fail++;
      else if (c.verdict === 'insufficient') insufficient++;
      else pass++;
      if (c.reasons.some(r => r.kind === 'regression')) qualityFail++;
    }
    cells.push({ scenario: sc.name, n: sc.n, drop: sc.drop, fail: fail / TRIALS, insufficient: insufficient / TRIALS, pass: pass / TRIALS, qualityFail: qualityFail / TRIALS });
  }
}

// Several runs of the same 20 items: per-item difficulty fixed, fresh noise per run. Does adding runs
// raise detection while false alarms stay at the level? (binary scores; drop 0 and 0.1)
const multiRun: Array<{ runs: number; drop: number; test: string; fail: number }> = [];
for (const drop of [0, 0.1])
  for (const runs of [1, 3, 5])
    for (const test of ['sign-flip', 'betting'] as const) {
      const u = rng(seed++);
      let fails = 0;
      for (let t = 0; t < TRIALS; t++) {
        const p = Array.from({ length: 20 }, () => 0.3 + 0.5 * u());
        const draw = (q: number) => (u() < q ? 1 : 0);
        const runsA: ExperimentRows[] = [], runsB: ExperimentRows[] = [];
        for (let k = 0; k < runs; k++) {
          const tr: Trial = { scorers: ['q'], items: p.map(q => ({ q: { a: [draw(q)], b: [draw(q - drop)] } })) };
          runsA.push(rows(`A${k}`, tr, 'a'));
          runsB.push(rows(`B${k}`, tr, 'b'));
        }
        if (compareRows(runsA, runsB, { resamples: 2000, seed: t + 1, test }).verdict === 'fail') fails++;
      }
      multiRun.push({ runs, drop, test, fail: fails / TRIALS });
    }

// Resample check: one cell at the production default.
const check = scenarios.find(s => s.name === 'symmetric null, continuous' && s.n === 50)!;
const resampleCheck = [20000].map(resamples => {
  const u = rng(4242);
  let fails = 0;
  for (let t = 0; t < 400; t++) {
    const trial = check.make(u);
    if (compareRows(rows('A', trial, 'a'), rows('B', trial, 'b'), { resamples, seed: t + 1 }).verdict === 'fail') fails++;
  }
  return { trials: 400, resamples, failRate: fails / 400 };
});

writeFileSync('results/gate-sim.json', JSON.stringify({ trials: TRIALS, alpha: 0.05, cells, multiRun, resampleCheck }, null, 2));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
let md = `# The whole gate, simulated\n\n${TRIALS} trials per cell, alpha 0.05, default options (\`allowSubset\` on). "fail" = gate verdict FAIL; "quality fail" = a regression reason (the statistical test); "insufficient" = no verdict.\nWith drop 0 every FAIL is a false alarm. MC s.e. ≤ 1.6 pts.\n\n`;
md += '| scenario | n | true drop | FAIL | quality FAIL | INSUFFICIENT | PASS |\n|---|---|---|---|---|---|---|\n';
for (const c of cells) md += `| ${c.scenario} | ${c.n} | ${c.drop} | ${pct(c.fail)} | ${pct(c.qualityFail)} | ${pct(c.insufficient)} | ${pct(c.pass)} |\n`;
md += '\n## Several runs of the same 20 items (binary scores)\n\n| runs | true drop | test | FAIL |\n|---|---|---|---|\n';
for (const m of multiRun) md += `| ${m.runs} | ${m.drop} | ${m.test} | ${pct(m.fail)} |\n`;
md += `\nResample check (symmetric null, n=50, 400 trials, 20000 resamples): ${resampleCheck.map(r => pct(r.failRate)).join(', ')}.\n`;
writeFileSync('results/gate-sim.md', md);
console.log(md);
