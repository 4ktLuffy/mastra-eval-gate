/**
 * Re-gate every saved real run (results/real/*.json) with the current gate, offline: no model calls.
 * The gate's semantics changed after the second review (insufficient verdict, gross coverage, reliability
 * modes), so the real-data claims are recomputed from the stored rows rather than carried over.
 *
 *   npx tsx bench/regate.ts   (writes results/real/regate.{json,md})
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareRows, type CompareOptions, type ExperimentRows } from '../src/index.js';

/** A saved run, with per-item run time and tokens restored from its saved outputs when present. */
const load = (name: string): ExperimentRows => {
  const saved = JSON.parse(readFileSync(`results/real/${name}.json`, 'utf8'));
  const outputs = new Map<string, { seconds?: number | null; output?: { usage?: { totalTokens?: number } } | null }>(
    (saved.outputs ?? []).map((o: { itemId: string }) => [o.itemId, o]),
  );
  const results = saved.rows.results.map((r: { itemId: string }) => {
    const o = outputs.get(r.itemId);
    return {
      ...r,
      durationMs: typeof o?.seconds === 'number' ? o.seconds * 1000 : null,
      tokens: typeof o?.output?.usage?.totalTokens === 'number' ? o.output.usage.totalTokens : null,
    };
  });
  return { ...saved.rows, results, id: name, status: 'completed' };
};
const groups: Array<{ group: string; noChange: boolean; pairs: Array<[string, string]> }> = [
  { group: 'R: same config (R1-R3)', noChange: true, pairs: [['R1', 'R2'], ['R2', 'R1'], ['R1', 'R3'], ['R3', 'R1'], ['R2', 'R3'], ['R3', 'R2']] },
  { group: 'R4 (2 Codex hangs) vs R1-R3', noChange: true, pairs: [['R1', 'R4'], ['R2', 'R4'], ['R3', 'R4'], ['R4', 'R1'], ['R4', 'R2'], ['R4', 'R3']] },
  { group: 'R5 (20 s timeout, 7/30 timed out) vs R1-R4', noChange: false, pairs: [['R1', 'R5'], ['R2', 'R5'], ['R3', 'R5'], ['R4', 'R5']] },
  { group: 'B1/B2 same config', noChange: true, pairs: [['B1', 'B2'], ['B2', 'B1']] },
  { group: 'live tool L1-L3', noChange: true, pairs: [['L1', 'L2'], ['L2', 'L1'], ['L1', 'L3'], ['L3', 'L1'], ['L2', 'L3'], ['L3', 'L2']] },
  { group: 'toolMocks M1-M3', noChange: true, pairs: [['M1', 'M2'], ['M2', 'M1'], ['M1', 'M3'], ['M3', 'M1'], ['M2', 'M3'], ['M3', 'M2']] },
  { group: 'effort medium -> none (30/30 -> 13/30)', noChange: false, pairs: [['MED', 'NONE']] },
];
const modes: Record<string, CompareOptions> = { strict: {}, statistical: { reliability: 'statistical' }, betting: { test: 'betting' } };
const out: Array<Record<string, unknown>> = [];
for (const g of groups)
  for (const [a, b] of g.pairs)
    for (const [mode, opts] of Object.entries(modes)) {
      const c = compareRows(load(a), load(b), opts);
      out.push({ group: g.group, noChange: g.noChange, pair: `${a}->${b}`, mode, verdict: c.verdict, reasons: c.reasons.map(r => `${r.severity}:${r.kind}`), newFailures: c.reliability.newFailures, reliabilityP: c.reliability.pValue });
    }
// Run time and tokens on real runs (saved per item where the run recorded them).
const resources = [
  ['R1', 'R2', 'same config: no change expected'],
  ['R2', 'R3', 'same config: no change expected'],
  ['R1', 'R5', '20 s item timeout'],
  ['B1', 'B2', 'same config: no change expected'],
  ['B1', 'D', 'prompt: reply with only the final number'],
].map(([a, b, what]) => {
  const c = compareRows(load(a!), load(b!));
  return { pair: `${a}->${b}`, what, latency: c.resources.latency ?? null, tokens: c.resources.tokens ?? null, warnings: c.warnings.filter(w => /Run time|Token use/.test(w)) };
});
// Several runs at once: both support baselines against both regressed runs (betting pairs them in order).
const multi = (['sign-flip', 'betting'] as const).map(test => {
  const c = compareRows([load('SB1'), load('SB2')], [load('SX1'), load('SX2')], { test });
  return { test, verdict: c.verdict, change: c.scorers.action?.change, p: c.scorers.action?.pAdjusted };
});
writeFileSync('results/real/regate-resources.json', JSON.stringify({ resources, multi }, null, 2));
console.log(JSON.stringify({ resources: resources.map(r => ({ pair: r.pair, what: r.what, latency: r.latency && { ratio: +r.latency.ratio.toFixed(3), p: +r.latency.pValue.toFixed(4) }, tokens: r.tokens && { ratio: +r.tokens.ratio.toFixed(3), p: +r.tokens.pValue.toFixed(4) } })), multi }, null, 1));

writeFileSync('results/real/regate.json', JSON.stringify(out, null, 2));
let md = '# Saved real runs, re-gated with the current gate\n\n| group | mode | pairs | pass | fail | insufficient |\n|---|---|---|---|---|---|\n';
for (const g of groups)
  for (const mode of Object.keys(modes)) {
    const rows = out.filter(r => r.group === g.group && r.mode === mode);
    const count = (v: string) => rows.filter(r => r.verdict === v).length;
    md += `| ${g.group} | ${mode} | ${rows.length} | ${count('pass')} | ${count('fail')} | ${count('insufficient')} |\n`;
  }
writeFileSync('results/real/regate.md', md);
console.log(md);
for (const r of out.filter(r => r.verdict !== 'pass')) console.log(r.pair, r.mode, r.verdict, (r.reasons as string[]).join(' '));
