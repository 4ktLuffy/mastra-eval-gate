import type { Comparison } from './compare.js';

const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '–');

/** Plain-text report for a terminal or CI log. */
export function formatReport(c: Comparison): string {
  const lines: string[] = [];
  lines.push(`${c.passed ? 'PASS' : 'FAIL'}  baseline ${c.baselineId}  →  candidate ${c.candidateId}`);
  for (const r of c.reasons) lines.push(`  ✗ ${r.message}`);
  for (const w of c.warnings) lines.push(`  ! ${w}`);
  const rel = c.reliability;
  lines.push('');
  lines.push(`Reliability: ${rel.failedA}/${rel.items} failed in baseline, ${rel.failedB}/${rel.items} in candidate (${rel.newFailures} new, ${rel.fixedFailures} fixed; McNemar p = ${f(rel.pValue)})`);
  lines.push('');
  lines.push(`${'scorer'.padEnd(28)} ${'n'.padStart(4)}  ${'baseline'.padStart(8)}  ${'candidate'.padStart(9)}  ${'change'.padStart(7)}  ${'95% CI'.padEnd(17)}  ${'p(Holm)'.padStart(7)}  ${'min.detect'.padStart(10)}`);
  for (const s of Object.values(c.scorers)) {
    if (s.status !== 'ok') {
      lines.push(`${s.scorerId.padEnd(28)} ${s.status}`);
      continue;
    }
    const flag = s.regressed ? ' ✗' : s.inconclusive ? ' ?' : '';
    const ci = `[${f(s.changeCI[0])}, ${f(s.changeCI[1])}]`;
    lines.push(
      `${s.scorerId.padEnd(28)} ${String(s.pairedN).padStart(4)}  ${f(s.meanA).padStart(8)}  ${f(s.meanB).padStart(9)}  ${f(s.change).padStart(7)}  ${ci.padEnd(17)}  ${f(s.pAdjusted).padStart(7)}  ${f(s.minimumDetectable).padStart(10)}${flag}`,
    );
  }
  return lines.join('\n');
}
