import { describe, expect, it } from 'vitest';
import { compareRows, type ExperimentRows, type ResultRow, type ScoreRow } from '../src/compare.js';

const items = (n: number) => Array.from({ length: n }, (_, i) => `q${i + 1}`);
function exp(id: string, rows: Array<{ item: string; scores?: Record<string, number>; error?: boolean; attempt?: number }>): ExperimentRows {
  const results: ResultRow[] = rows.map(r => ({ itemId: r.item, attempt: r.attempt ?? 0, error: r.error ? new Error('boom') : null }));
  const scores: ScoreRow[] = rows.flatMap(r => Object.entries(r.scores ?? {}).map(([scorerId, score]) => ({ scorerId, entityId: r.item, score })));
  return { id, results, scores };
}
const q = (i: number) => (i >= 8 ? 0.3 : 0.9);

describe('compareRows', () => {
  it('negative control: identical runs pass', () => {
    const a = exp('A', items(10).map((item, i) => ({ item, scores: { quality: q(i + 1) } })));
    const c = compareRows(a, { ...a, id: 'B' });
    expect(c.passed).toBe(true);
    expect(c.scorers.quality!.change).toBe(0);
  });

  it('G1: compares the shared items, not different item sets', () => {
    const a = exp('A', items(10).map((item, i) => ({ item, scores: { quality: q(i + 1) } })));
    // B only ran the three hard items, each slightly better than A.
    const b = exp('B', ['q8', 'q9', 'q10'].map(item => ({ item, scores: { quality: 0.35 } })));
    const c = compareRows(a, b);
    expect(c.scorers.quality!.pairedN).toBe(3);
    expect(c.scorers.quality!.change).toBeCloseTo(0.05, 10);
    expect(c.scorers.quality!.regressed).toBe(false);
    expect(c.scorers.quality!.unpaired.meanB).toBeCloseTo(0.35, 10); // old view: 0.72 -> 0.35
    expect(c.warnings.some(w => w.startsWith('Item sets differ'))).toBe(true);
  });

  it('G3: a scorer missing from the candidate fails the gate instead of scoring 0', () => {
    const a = exp('A', items(5).map(item => ({ item, scores: { quality: 0.7, harm: 0.4 } })));
    const b = exp('B', items(5).map(item => ({ item, scores: { quality: 0.7 } })));
    const c = compareRows(a, b, { thresholds: { harm: { value: 0.05, direction: 'lower-is-better' } } });
    expect(c.scorers.harm!.status).toBe('missing-in-candidate');
    expect(c.passed).toBe(false);
    expect(c.reasons.map(r => r.kind)).toEqual(['missing-scorer']);
  });

  it('G3 reversed: a scorer new in the candidate is a warning, not a regression', () => {
    const a = exp('A', items(5).map(item => ({ item, scores: { quality: 0.7 } })));
    const b = exp('B', items(5).map(item => ({ item, scores: { quality: 0.7, harm: 0.4 } })));
    const c = compareRows(a, b, { thresholds: { harm: { value: 0.05, direction: 'lower-is-better' } } });
    expect(c.passed).toBe(true);
    expect(c.scorers.harm!.status).toBe('missing-in-baseline');
  });

  it('G4: repeated attempts are averaged per item, not overwritten', () => {
    const a = exp('A', items(4).map(item => ({ item, scores: { quality: 0.4 } })));
    const b = exp('B', items(4).flatMap(item => [0.9, 0.1, 0.2].map((s, attempt) => ({ item, attempt, scores: { quality: s } }))));
    const c = compareRows(a, b);
    expect(c.scorers.quality!.meanB).toBeCloseTo(0.4, 10);
    expect(c.scorers.quality!.change).toBeCloseTo(0, 10);
    expect(c.passed).toBe(true);
  });

  it('G5: target failures count against reliability and never raise the mean', () => {
    const a = exp('A', items(10).map((item, i) => ({ item, scores: { quality: q(i + 1), keyword: 0 } })));
    // B crashes on the hard items; a scorer still gives the crashed runs a perfect 1.0.
    const b = exp('B', items(10).map((item, i) =>
      i + 1 >= 8 ? { item, error: true, scores: { keyword: 1 } } : { item, scores: { quality: q(i + 1), keyword: 0 } },
    ));
    const c = compareRows(a, b);
    expect(c.reliability.newFailures).toBe(3);
    expect(c.passed).toBe(false);
    expect(c.reasons.map(r => r.kind)).toContain('reliability');
    expect(c.scorers.keyword!.change).toBe(0); // the 1.0s on crashed runs are excluded
    expect(c.scorers.quality!.lostInB['target-error']).toBe(3);
  });

  it('G2: a scorer that silently stops scoring is a coverage failure', () => {
    const a = exp('A', items(6).map(item => ({ item, scores: { quality: 0.8 } })));
    const b = exp('B', items(6).map((item, i) => ({ item, scores: i < 4 ? { quality: 0.8 } : {} })));
    const c = compareRows(a, b);
    expect(c.scorers.quality!.lostInB['no-score']).toBe(2);
    expect(c.reasons.map(r => r.kind)).toEqual(['coverage']);
  });

  it('flags a real, consistent regression', () => {
    const a = exp('A', items(12).map(item => ({ item, scores: { quality: 0.8 } })));
    const b = exp('B', items(12).map((item, i) => ({ item, scores: { quality: 0.8 - 0.1 - (i % 3) * 0.02 } })));
    const c = compareRows(a, b, { thresholds: { quality: { value: 0.05 } } });
    expect(c.scorers.quality!.regressed).toBe(true);
    expect(c.reasons[0]!.kind).toBe('regression');
  });

  it('a drop inside noise is inconclusive, not a regression', () => {
    const drops = [0.3, -0.25, 0.2, -0.3, 0.1, -0.2, 0.15, -0.1];
    const a = exp('A', items(8).map(item => ({ item, scores: { quality: 0.5 } })));
    const b = exp('B', items(8).map((item, i) => ({ item, scores: { quality: 0.5 + drops[i]! - 0.02 } })));
    const c = compareRows(a, b);
    expect(c.scorers.quality!.regressed).toBe(false);
    expect(c.scorers.quality!.inconclusive).toBe(true);
    expect(c.passed).toBe(true);
  });

  describe('review fixes', () => {
    it('bug 1: a failed attempt\'s score is excluded when the attempt is known', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const b: ExperimentRows = {
        id: 'B',
        results: items(10).flatMap(itemId => [{ itemId, attempt: 0, error: null }, { itemId, attempt: 1, error: new Error('x') }]),
        scores: items(10).flatMap(entityId => [
          { scorerId: 'quality', entityId, score: 0.9, attempt: 0 },
          { scorerId: 'quality', entityId, score: 0.0, attempt: 1 },
        ]),
      };
      const c = compareRows(a, b);
      expect(c.scorers.quality!.change).toBeCloseTo(0, 10);
      expect(c.reliability.newFailures).toBe(10);
      expect(c.reasons.map(r => r.kind)).toEqual(['reliability']);
    });

    it('bug 1: an unattributable score is kept but flagged', () => {
      const a = exp('A', items(3).map(item => ({ item, scores: { quality: 0.9 } })));
      const b: ExperimentRows = {
        id: 'B',
        results: items(3).flatMap(itemId => [{ itemId, attempt: 0, error: null }, { itemId, attempt: 1, error: new Error('x') }]),
        scores: items(3).map(entityId => ({ scorerId: 'quality', entityId, score: 0.9 })),
      };
      expect(compareRows(a, b).warnings.some(w => w.includes('could not be matched to an attempt'))).toBe(true);
    });

    it('bug 2: disjoint item sets fail', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(10).map(item => ({ item: `z-${item}`, scores: { quality: 0.1 } })));
      const c = compareRows(a, b, { allowSubset: true });
      expect(c.passed).toBe(false);
      expect(c.reasons.some(r => r.kind === 'coverage' && r.message.includes('no item scored in both'))).toBe(true);
    });

    it('bug 3: items the candidate never ran fail coverage unless allowSubset', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(3).map(item => ({ item, scores: { quality: 0.9 } })));
      expect(compareRows(a, b).reasons.map(r => r.kind)).toEqual(['coverage']);
      expect(compareRows(a, b, { allowSubset: true }).passed).toBe(true);
    });

    it('bug 4: a NaN score is not a pass', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(10).map((item, i) => ({ item, scores: { quality: i === 0 ? Number.NaN : 0.1 } })));
      const c = compareRows(a, b);
      expect(c.passed).toBe(false);
      expect(c.scorers.quality!.regressed).toBe(true); // the 9 valid items dropped 0.8
      expect(c.reasons.some(r => r.kind === 'coverage')).toBe(true); // the NaN item lost its score
      expect(c.warnings.some(w => w.includes('non-finite'))).toBe(true);
    });

    it('bug 5: a scorer with only null scores in the baseline is reported, not silently compared', () => {
      const a = exp('A', items(5).map(item => ({ item, scores: { quality: 0.9 } })));
      a.scores.push(...items(5).map(entityId => ({ scorerId: 'harm', entityId, score: null })));
      const b = exp('B', items(5).map(item => ({ item, scores: { quality: 0.9, harm: 0.2 } })));
      const c = compareRows(a, b);
      expect(c.scorers.harm!.status).toBe('missing-in-baseline');
      expect(c.warnings.some(w => w.includes('"harm" has no scores in the baseline'))).toBe(true);
    });

    it('bug 6: too few items to ever be significant is said plainly', () => {
      const a = exp('A', items(4).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(4).map(item => ({ item, scores: { quality: 0.1 } })));
      const c = compareRows(a, b);
      expect(c.scorers.quality!.inconclusive).toBe(true);
      expect(c.scorers.quality!.minimumDetectable).toBe(Number.POSITIVE_INFINITY);
      expect(c.warnings.some(w => w.includes('can never reach p < 0.05') && w.includes('need at least 6'))).toBe(true);
    });

    it('bug 7: a drop exactly at the tolerance is not "beyond" it', () => {
      const a = exp('A', items(20).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(20).map(item => ({ item, scores: { quality: 0.8 } })));
      const c = compareRows(a, b, { thresholds: { quality: { value: 0.1 } } });
      expect(c.scorers.quality!.inconclusive).toBe(false);
      expect(c.scorers.quality!.regressed).toBe(false);
      expect(c.warnings).toEqual([]);
    });
  });

  it('coverage is net: a scorer that misses an item in each run is not a failure', () => {
    // Real case (bench/real-detect.ts): a Codex judge errored on one item in each run.
    const a = exp('A', items(6).map((item, i) => ({ item, scores: i === 0 ? { quality: 0.8 } : { quality: 0.8, judge: 1 } })));
    const b = exp('B', items(6).map((item, i) => ({ item, scores: i === 1 ? { quality: 0.8 } : { quality: 0.8, judge: 1 } })));
    const c = compareRows(a, b);
    expect(c.scorers.judge!.lostInB['no-score']).toBe(1);
    expect(c.scorers.judge!.lostInA['no-score']).toBe(1);
    expect(c.passed).toBe(true);
    const worse = exp('B', items(6).map((item, i) => ({ item, scores: i <= 2 ? { quality: 0.8 } : { quality: 0.8, judge: 1 } })));
    expect(compareRows(a, worse).reasons.map(r => r.kind)).toEqual(['coverage']); // lost 2 net
  });
});
