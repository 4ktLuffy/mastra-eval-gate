import { describe, expect, it } from 'vitest';
import { compareRows, type ExperimentRows, type ResultRow, type ScoreRow } from '../src/compare.js';

const items = (n: number) => Array.from({ length: n }, (_, i) => `q${i + 1}`);
function exp(id: string, rows: Array<{ item: string; scores?: Record<string, number | undefined>; error?: boolean; attempt?: number }>): ExperimentRows {
  const results: ResultRow[] = rows.map(r => ({ itemId: r.item, attempt: r.attempt ?? 0, error: r.error ? new Error('boom') : null }));
  const scores: ScoreRow[] = rows.flatMap(r =>
    Object.entries(r.scores ?? {}).flatMap(([scorerId, score]) => (score === undefined ? [] : [{ scorerId, entityId: r.item, score, attempt: r.attempt ?? 0 }])),
  );
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
    const a = exp('A', items(6).map(item => ({ item, scores: { quality: 0.4 } })));
    const b = exp('B', items(6).flatMap(item => [0.9, 0.1, 0.2].map((s, attempt) => ({ item, attempt, scores: { quality: s } }))));
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

  it('G2: a scorer that silently stops scoring makes the evidence insufficient', () => {
    const a = exp('A', items(12).map(item => ({ item, scores: { quality: 0.8 } })));
    const b = exp('B', items(12).map((item, i) => ({ item, scores: i < 10 ? { quality: 0.8 } : {} })));
    const c = compareRows(a, b);
    expect(c.scorers.quality!.lostInB['no-score']).toBe(2);
    expect(c.verdict).toBe('insufficient');
    expect(c.reasons.map(r => [r.kind, r.severity])).toEqual([['coverage', 'insufficient']]);
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
      expect(c.verdict).toBe('insufficient');
      expect(c.reasons.some(r => r.kind === 'no-evidence' && r.message.includes('no item scored in both'))).toBe(true);
    });

    it('bug 3: items the candidate never ran fail coverage unless allowSubset', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(6).map(item => ({ item, scores: { quality: 0.9 } })));
      const c = compareRows(a, b);
      expect(c.verdict).toBe('insufficient');
      expect(c.reasons.map(r => r.kind)).toEqual(['coverage']);
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
      expect(c.verdict).toBe('insufficient');
      expect(c.reasons.some(r => r.kind === 'too-few-items' && r.message.includes('at least 5 are needed'))).toBe(true);
      // 5 items can reach p = 1/32 < 0.05 (the old message said 6 were needed)
      const a5 = exp('A', items(5).map(item => ({ item, scores: { quality: 0.9 } })));
      const b5 = exp('B', items(5).map(item => ({ item, scores: { quality: 0.1 } })));
      expect(compareRows(a5, b5).scorers.quality!.regressed).toBe(true);
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

  it('a scorer outage makes the verdict insufficient, never pass and never fail', () => {
    // Real case (bench/real-detect.ts): a Codex judge errored on an item in each run.
    const a = exp('A', items(12).map((item, i) => ({ item, scores: i === 0 ? { quality: 0.8 } : { quality: 0.8, judge: 1 } })));
    const b = exp('B', items(12).map((item, i) => ({ item, scores: i === 1 ? { quality: 0.8 } : { quality: 0.8, judge: 1 } })));
    const c = compareRows(a, b);
    expect(c.scorers.judge!.lostInB['no-score']).toBe(1);
    expect(c.verdict).toBe('insufficient');
    expect(compareRows(a, b, { maxCoverageLoss: 1 }).verdict).toBe('pass');
  });

  describe('second review (gpt-6-astra) fixes', () => {
    it('empty experiments are insufficient, not pass', () => {
      const e: ExperimentRows = { id: 'A', results: [], scores: [] };
      const c = compareRows(e, { ...e, id: 'B' });
      expect(c.verdict).toBe('insufficient');
      expect(c.passed).toBe(false);
    });

    it('experiments with results but no scores are insufficient', () => {
      const a = exp('A', items(10).map(item => ({ item })));
      const c = compareRows(a, { ...a, id: 'B' }, { thresholds: { quality: { value: 0.05 } } });
      expect(c.verdict).toBe('insufficient');
      expect(c.reasons.some(r => r.message.includes('No scores in either experiment'))).toBe(true);
    });

    it('an expected scorer that never ran is reported', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const c = compareRows(a, { ...a, id: 'B' }, { expectedScorers: ['quality', 'faithfulness'] });
      expect(c.verdict).toBe('insufficient');
      expect(c.reasons.map(r => r.scorerId)).toEqual(['faithfulness']);
    });

    it('an unfinished experiment is insufficient', () => {
      const a = { ...exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } }))), status: 'completed' };
      const c = compareRows(a, { ...a, id: 'B', status: 'running' });
      expect(c.verdict).toBe('insufficient');
      expect(c.reasons[0]!.kind).toBe('incomplete');
    });

    it('invalid options throw instead of disabling the check', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      expect(() => compareRows(a, a, { thresholds: { quality: { value: Number.NaN } } })).toThrow(TypeError);
      expect(() => compareRows(a, a, { thresholds: { quality: { value: -0.1 } } })).toThrow('finite number >= 0');
      expect(() => compareRows(a, a, { alpha: 1.5 })).toThrow('alpha');
      expect(() => compareRows(a, a, { maxCoverageLoss: -1 })).toThrow('maxCoverageLoss');
      expect(() => compareRows(a, a, { reliability: 'loose' as never })).toThrow('reliability must be');
      expect(() => compareRows(a, a, { resamples: 1e100 })).toThrow('resamples');
      expect(() => compareRows(a, a, { seed: 0.5 })).toThrow('seed');
    });

    it('fixed items do not offset newly broken ones', () => {
      const row = (item: string, failed: boolean) => (failed ? { item, error: true } : { item, scores: { quality: 0.5 } });
      const a = exp('A', items(10).map((item, i) => row(item, i < 3)));
      const b = exp('B', items(10).map((item, i) => row(item, i >= 7)));
      const c = compareRows(a, b, { allowSubset: true });
      expect(c.reliability.newFailures).toBe(3);
      expect(c.reliability.fixedFailures).toBe(3);
      expect(c.verdict).toBe('fail');
    });

    it('more repetitions are not penalised: reliability compares failure rates', () => {
      // Baseline: 1 attempt per item, 0 failures. Candidate: 3 attempts, 1 failure in 3 on two items.
      const a = exp('A', items(6).map(item => ({ item, scores: { quality: 0.5 } })));
      const b: ExperimentRows = {
        id: 'B',
        results: items(6).flatMap((itemId, i) => [0, 1, 2].map(attempt => ({ itemId, attempt, error: i < 2 && attempt === 0 ? new Error('x') : null }))),
        scores: items(6).flatMap((entityId, i) => [0, 1, 2].filter(attempt => !(i < 2 && attempt === 0)).map(attempt => ({ scorerId: 'quality', entityId, score: 0.5, attempt }))),
      };
      const c = compareRows(a, b);
      expect(c.reliability.excessFailures).toBeCloseTo(2 / 3, 10);
      expect(c.verdict).toBe('fail'); // 0.67 extra failed runs > 0 allowed
      expect(compareRows(a, b, { maxNewTargetFailures: 1 }).verdict).toBe('pass');
    });

    it('lists the items behind the verdict', () => {
      const a = exp('A', items(10).map(item => ({ item, scores: { quality: 0.9 } })));
      const b = exp('B', items(10).map((item, i) => (i === 0 ? { item, error: true } : { item, scores: { quality: i === 1 ? 0.2 : 0.9 } })));
      const c = compareRows(a, b);
      expect(c.items[0]).toMatchObject({ itemId: 'q1', kind: 'new-failure' });
      expect(c.items[1]).toMatchObject({ itemId: 'q2', kind: 'drop', baseline: 0.9, candidate: 0.2 });
    });

    it("reliability: 'statistical' needs a significant increase; 'strict' (default) fails on any", () => {
      const row = (item: string, failed: boolean) => (failed ? { item, error: true } : { item, scores: { quality: 0.5 } });
      const a = exp('A', items(20).map(item => row(item, false)));
      const two = exp('B', items(20).map((item, i) => row(item, i < 2))); // 2 new failures: p = 0.25
      expect(compareRows(a, two).verdict).toBe('fail');
      const stat = compareRows(a, two, { reliability: 'statistical' });
      expect(stat.reliability.pValue).toBeCloseTo(0.25, 10);
      expect(stat.verdict).toBe('pass');
      expect(stat.warnings.some(w => w.includes("not significant (p = 0.250) under reliability: 'statistical'"))).toBe(true);
      const seven = exp('B', items(20).map((item, i) => row(item, i < 7))); // p = 1/128
      expect(compareRows(a, seven, { reliability: 'statistical' }).verdict).toBe('fail');
    });

    it('clusters: the quality test runs on per-cluster means', () => {
      // 12 items in 6 clusters of 2; every item in clusters c0-c4 drops 0.3, c5 is unchanged.
      const a = exp('A', items(12).map(item => ({ item, scores: { quality: 0.8 } })));
      const b = exp('B', items(12).map((item, i) => ({ item, scores: { quality: i < 10 ? 0.5 : 0.8 } })));
      const clusters = Object.fromEntries(items(12).map((item, i) => [item, `c${Math.floor(i / 2)}`]));
      const c = compareRows(a, b, { clusters });
      expect(c.scorers.quality!.pairedN).toBe(12);
      expect(c.scorers.quality!.testUnits).toBe(6);
      expect(c.scorers.quality!.pValue).toBeCloseTo(1 / 32, 10); // 5 clusters dropped, 1 unchanged
      expect(c.verdict).toBe('fail');
      // With 4 clusters, too few for any verdict.
      const four = Object.fromEntries(items(12).map((item, i) => [item, `c${i % 4}`]));
      expect(compareRows(a, b, { clusters: four }).reasons.map(r => r.kind)).toContain('too-few-items');
    });

  });

  describe('third review (gpt-6-astra on 0.2.0): adversarial inputs', () => {
    const make = (id: string, values: number[], scorerId = 'q'): ExperimentRows => ({
      id,
      status: 'completed',
      results: values.map((_, i) => ({ itemId: `i${i}`, attempt: 0, error: null })),
      scores: values.map((score, i) => ({ entityId: `i${i}`, scorerId, attempt: 0, score })),
    });
    const a = make('A', Array(6).fill(1));
    const verdict = (x: ExperimentRows, y: ExperimentRows, o?: Parameters<typeof compareRows>[2]) => compareRows(x, y, o).verdict;

    it('an unscored baseline, or all-null / all-NaN scores, is never a pass', () => {
      expect(verdict({ ...a, scores: [] }, make('B', Array(6).fill(1)))).toBe('insufficient');
      const nulls = (r: ExperimentRows) => ({ ...r, scores: r.scores.map(x => ({ ...x, score: null })) });
      expect(verdict(nulls(a), nulls(make('B', Array(6).fill(1))))).toBe('insufficient');
      const nans = (r: ExperimentRows) => ({ ...r, scores: r.scores.map(x => ({ ...x, score: Number.NaN })) });
      expect(verdict(nans(a), nans(make('B', Array(6).fill(1))))).toBe('insufficient');
    });

    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('a scorer named %s is gated like any other', id => {
      expect(verdict(make('A', Array(6).fill(1), id), make('B', Array(6).fill(0), id), { expectedScorers: [id] })).toBe('fail');
    });

    it('a scorer outage on some attempts is insufficient, not an improvement', () => {
      const mixed = (id: string, scores: number[]): ExperimentRows => ({
        id,
        status: 'completed',
        results: Array.from({ length: 6 }, (_, i) => scores.map((_, attempt) => ({ itemId: `i${i}`, attempt, error: null }))).flat(),
        scores: Array.from({ length: 6 }, (_, i) => scores.map((score, attempt) => ({ entityId: `i${i}`, scorerId: 'q', attempt, score }))).flat(),
      });
      const ma = mixed('A', [1, 0]);
      const mb = mixed('B', [1, Number.NaN]);
      expect(verdict(ma, mb)).toBe('insufficient');
      expect(verdict(ma, { ...mb, scores: mb.scores.filter(x => x.attempt === 0) })).toBe('insufficient');
      // The same items skipped (e.g. notScorable) in both runs is not a loss.
      const skip = (r: ExperimentRows) => ({ ...r, scores: r.scores.filter(x => x.entityId !== 'i0') });
      expect(compareRows(skip(make('A', Array(6).fill(1))), skip(make('B', Array(6).fill(1)))).reasons.map(r => r.kind)).not.toContain('coverage');
    });

    it('a cluster id cannot collide with an unclustered item', () => {
      const c = compareRows(make('A', Array(5).fill(1)), make('B', Array(5).fill(0)), { clusters: { i0: 'item:i1' } });
      expect(c.scorers.q!.testUnits).toBe(5);
      expect(c.verdict).toBe('fail');
    });

    it('scores that overflow when averaged are insufficient, not a pass', () => {
      expect(verdict(make('A', Array(6).fill(1e308)), make('B', Array(6).fill(0)))).toBe('insufficient');
    });

    it('rejects resamples that would hang, non-integer seeds and non-string cluster ids', () => {
      expect(() => compareRows(a, a, { resamples: 1e100 })).toThrow(TypeError);
      expect(() => compareRows(a, a, { seed: Number.NaN })).toThrow(TypeError);
      expect(() => compareRows(a, a, { clusters: { i0: 23 as never } })).toThrow(TypeError);
    });

    it('a crash on an item only the candidate ran is warned about (reliability covers shared items)', () => {
      const extra = make('B', Array(6).fill(1));
      extra.results.push({ itemId: 'extra', attempt: 0, error: 'crash' });
      const c = compareRows(a, extra);
      expect(c.warnings.some(w => w.includes('only in the candidate had failed runs'))).toBe(true);
    });
  });
});
