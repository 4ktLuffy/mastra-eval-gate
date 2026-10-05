/**
 * Re-gate every saved real run (results/real/*.json) with the current gate, offline: no model calls.
 * The gate's semantics changed after the second review (insufficient verdict, gross coverage, reliability
 * modes), so the real-data claims are recomputed from the stored rows rather than carried over.
 *
 *   npx tsx bench/regate.ts   (writes results/real/regate.{json,md})
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compareRows, type CompareOptions, type ExperimentRows } from '../src/index.js';

const load = (name: string): ExperimentRows => {
  const saved = JSON.parse(readFileSync(`results/real/${name}.json`, 'utf8'));
  return { ...saved.rows, id: name, status: 'completed' };
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
const modes: Record<string, CompareOptions> = { strict: {}, statistical: { reliability: 'statistical' } };
const out: Array<Record<string, unknown>> = [];
for (const g of groups)
  for (const [a, b] of g.pairs)
    for (const [mode, opts] of Object.entries(modes)) {
      const c = compareRows(load(a), load(b), opts);
      out.push({ group: g.group, noChange: g.noChange, pair: `${a}->${b}`, mode, verdict: c.verdict, reasons: c.reasons.map(r => `${r.severity}:${r.kind}`), newFailures: c.reliability.newFailures, reliabilityP: c.reliability.pValue });
    }
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
