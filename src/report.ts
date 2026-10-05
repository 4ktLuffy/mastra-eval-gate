import type { Comparison } from './compare.js';

const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : x === Number.POSITIVE_INFINITY ? 'too few' : '–');
const v = (x: number | null) => (x === null ? '–' : x.toFixed(2));

const HEADLINE = {
  pass: 'PASS (no evidence of a regression)',
  fail: 'FAIL',
  insufficient: 'INSUFFICIENT EVIDENCE (no verdict)',
} as const;

/** Plain-text report for a terminal or CI log. */
export function formatReport(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`${HEADLINE[c.verdict]}  baseline ${c.baselineId}  →  candidate ${c.candidateId}`);
  for (const r of c.reasons) lines.push(`  ${r.severity === 'fail' ? '✗' : '?'} ${r.message}`);
  for (const w of c.warnings) lines.push(`  ! ${w}`);
  const rel = c.reliability;
  lines.push('');
  lines.push(
    `Reliability: ${rel.failedA}/${rel.items} items with a failed run in baseline, ${rel.failedB}/${rel.items} in candidate (${rel.newFailures} worse, ${rel.fixedFailures} better${Number.isFinite(rel.pValue) ? `; McNemar p = ${f(rel.pValue)}` : ''})`,
  );
  lines.push('');
  lines.push(`${'scorer'.padEnd(28)} ${'n'.padStart(4)}  ${'baseline'.padStart(8)}  ${'candidate'.padStart(9)}  ${'change'.padStart(7)}  ${'95% CI'.padEnd(17)}  ${'p(Holm)'.padStart(7)}  ${'detects'.padStart(8)}`);
  for (const s of Object.values(c.scorers)) {
    if (s.status !== 'ok') {
      lines.push(`${s.scorerId.padEnd(28)} ${s.status}`);
      continue;
    }
    const flag = s.regressed ? ' ✗' : s.inconclusive ? ' ?' : '';
    const ci = `[${f(s.changeCI[0])}, ${f(s.changeCI[1])}]`;
    lines.push(
      `${s.scorerId.padEnd(28)} ${String(s.pairedN).padStart(4)}  ${f(s.meanA).padStart(8)}  ${f(s.meanB).padStart(9)}  ${f(s.change).padStart(7)}  ${ci.padEnd(17)}  ${f(s.pAdjusted).padStart(7)}  ${f(s.minimumDetectable).padStart(8)}${flag}`,
    );
  }
  if (c.items.length) {
    lines.push('');
    lines.push('Items:');
    for (const d of c.items) {
      const what = d.kind === 'new-failure' ? 'run failure rate' : d.kind === 'lost-score' ? `${d.scorerId} score lost` : `${d.scorerId}`;
      lines.push(`  ${d.kind.padEnd(11)} ${d.itemId}  ${what}: ${v(d.baseline)} → ${v(d.candidate)}`);
    }
  }
  lines.push('');
  lines.push('"detects": smallest true drop caught 80% of the time at this n (approximate).');
  return lines.join('\n');
}
