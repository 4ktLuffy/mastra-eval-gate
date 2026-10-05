/**
 * The Phase 0 findings, run through real Mastra experiments: Mastra's own compareExperiments
 * next to compareRows on the same stored rows. Each test asserts the old verdict (so a change
 * upstream shows up here) and the new one.
 */
import { compareExperiments, runExperiment } from '@mastra/core/datasets';
import {
  createCompletenessScorer,
  createContentSimilarityScorer,
  createKeywordCoverageScorer,
  createTextualDifferenceScorer,
  createToneScorer,
} from '@mastra/evals/scorers/prebuilt';
import { describe, expect, it } from 'vitest';
import { gate } from '../src/index.js';
import { dataset, mastraWith, mockAgent, qualityScorer } from './helpers.js';

const hardIsLow = (n: number) => (n >= 8 ? 0.3 : 0.9);
const crashesOnHard = (n: number) => (n >= 8 ? 'throw' : 'ok') as const;

describe('target failures (G5)', () => {
  it('negative control: identical agents pass both', async () => {
    const m = mastraWith({ a: mockAgent('a', undefined, hardIsLow), b: mockAgent('b', undefined, hardIsLow) });
    const ds = await dataset(m);
    const A = await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers: [qualityScorer()] });
    const B = await ds.startExperiment({ targetType: 'agent', targetId: 'b', scorers: [qualityScorer()] });
    const old = await compareExperiments(m, { experimentIdA: A.experimentId, experimentIdB: B.experimentId });
    const ours = await gate(m, { baseline: A.experimentId, candidate: B.experimentId });
    expect(old.hasRegression).toBe(false);
    expect(ours.passed).toBe(true);
  });

  it('an agent that crashes on its 3 hardest items: old compare says it improved; the gate fails it', async () => {
    const m = mastraWith({ a: mockAgent('a', undefined, hardIsLow), b: mockAgent('b', crashesOnHard, hardIsLow) });
    const ds = await dataset(m);
    const A = await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers: [qualityScorer()] });
    const B = await ds.startExperiment({ targetType: 'agent', targetId: 'b', scorers: [qualityScorer()] });
    expect(B.failedCount).toBe(3);

    const old = await compareExperiments(m, { experimentIdA: A.experimentId, experimentIdB: B.experimentId });
    expect(old.hasRegression).toBe(false);
    expect(old.scorers.quality!.delta).toBeCloseTo(0.18, 10); // 0.72 -> 0.90
    expect(old.scorers.quality!.statsB.errorRate).toBe(0);

    const ours = await gate(m, { baseline: A.experimentId, candidate: B.experimentId });
    expect(ours.passed).toBe(false);
    expect(ours.reliability.newFailures).toBe(3);
    expect(ours.scorers.quality!.change).toBeCloseTo(0, 10); // shared items unchanged
  });

  it("with Mastra's prebuilt code scorers, crashes raise keyword coverage in the old compare", async () => {
    const scorers = [
      createCompletenessScorer(),
      createContentSimilarityScorer(),
      createKeywordCoverageScorer(),
      createTextualDifferenceScorer(),
      createToneScorer(),
    ];
    const m = mastraWith({ a: mockAgent('a', undefined, hardIsLow), b: mockAgent('b', crashesOnHard, hardIsLow) });
    const ds = await dataset(m);
    const A = await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers });
    const B = await ds.startExperiment({ targetType: 'agent', targetId: 'b', scorers });

    // The crashed runs are still scored; three prebuilt scorers give them a perfect 1.
    const crashed = B.results.filter(r => r.error);
    expect(crashed).toHaveLength(3);
    const perfect = crashed[0]!.scores.filter(s => s.score === 1).map(s => s.scorerId).sort();
    expect(perfect).toEqual(['keyword-coverage-scorer', 'textual-difference-scorer', 'tone-scorer']);

    const old = await compareExperiments(m, { experimentIdA: A.experimentId, experimentIdB: B.experimentId });
    expect(old.scorers['keyword-coverage-scorer']!.delta).toBeCloseTo(0.3, 10);
    expect(old.scorers['keyword-coverage-scorer']!.regressed).toBe(false);

    const ours = await gate(m, { baseline: A.experimentId, candidate: B.experimentId });
    expect(ours.scorers['keyword-coverage-scorer']!.change).toBeCloseTo(0, 10);
    expect(ours.reasons.map(r => r.kind)).toContain('reliability');
  });
});

describe('item sets, missing scorers, repeated attempts', () => {
  it('G1: a candidate run on a subset is compared on the shared items', async () => {
    // B is 0.05 better than A on every item, but only runs the 3 hard items.
    const m = mastraWith({ a: mockAgent('a', undefined, hardIsLow), b: mockAgent('b', undefined, n => hardIsLow(n) + 0.05) });
    const ds = await dataset(m);
    const A = await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers: [qualityScorer()] });
    const { items } = await ds.listItems();
    const subset = items
      .filter(i => Number(String(i.input).slice(1)) >= 8)
      .map(i => ({ id: i.id, input: i.input, groundTruth: i.groundTruth }));
    const B = await runExperiment(m, { data: subset, targetType: 'agent', targetId: 'b', scorers: [qualityScorer()] });

    const old = await compareExperiments(m, { experimentIdA: A.experimentId, experimentIdB: B.experimentId });
    expect(old.hasRegression).toBe(true); // 0.72 over 10 items vs 0.35 over 3

    // Compared on the 3 shared items (+0.05), but by default the 7 items B never ran fail coverage.
    const ours = await gate(m, { baseline: A.experimentId, candidate: B.experimentId });
    expect(ours.scorers.quality!.pairedN).toBe(3);
    expect(ours.scorers.quality!.change).toBeCloseTo(0.05, 10);
    expect(ours.scorers.quality!.regressed).toBe(false);
    expect(ours.reasons.map(r => r.kind)).toEqual(['coverage']);
    expect((await gate(m, { baseline: A.experimentId, candidate: B.experimentId, allowSubset: true })).passed).toBe(true);
  });

  it('G3: a scorer dropped from the candidate is a missing scorer, not a mean of 0', async () => {
    const m = mastraWith({ a: mockAgent('a', undefined, hardIsLow), b: mockAgent('b', undefined, hardIsLow) });
    const ds = await dataset(m);
    const A = await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers: [qualityScorer(), qualityScorer('harm')] });
    const B = await ds.startExperiment({ targetType: 'agent', targetId: 'b', scorers: [qualityScorer()] });
    const thresholds = { harm: { value: 0.05, direction: 'lower-is-better' as const } };

    const old = await compareExperiments(m, { experimentIdA: A.experimentId, experimentIdB: B.experimentId, thresholds });
    expect(old.scorers.harm!.statsB.avgScore).toBe(0);
    expect(old.scorers.harm!.regressed).toBe(false); // reads as an improvement

    const ours = await gate(m, { baseline: A.experimentId, candidate: B.experimentId, thresholds });
    expect(ours.scorers.harm!.status).toBe('missing-in-candidate');
    expect(ours.passed).toBe(false);
  });

  it('G4: repeated attempts are averaged, not last-one-wins', async () => {
    const flaky = (_n: number, call: number) => [0.9, 0.1, 0.2][call] ?? 0.2;
    const m = mastraWith({ a: mockAgent('a', undefined, () => 0.4), b: mockAgent('b', undefined, flaky) }, { quality: qualityScorer() });
    const ds = await dataset(m, 4);
    const { items } = await ds.listItems();
    const run = async (target: string, attempts: number) => {
      const { experimentId } = await ds.createExperiment({ targetType: 'agent', targetId: target, scorers: ['quality'] });
      for (const item of items) for (let attempt = 0; attempt < attempts; attempt++) await ds.runExperimentItem({ experimentId, itemId: item.id, attempt });
      await ds.finalizeExperiment({ experimentId });
      return experimentId;
    };
    const A = await run('a', 1);
    const B = await run('b', 3);

    const old = await compareExperiments(m, { experimentIdA: A, experimentIdB: B });
    expect(old.scorers.quality!.statsB.avgScore).toBeCloseTo(0.2, 10); // last attempt only
    expect(old.hasRegression).toBe(true);

    const ours = await gate(m, { baseline: A, candidate: B });
    expect(ours.scorers.quality!.meanB).toBeCloseTo(0.4, 10);
    expect(ours.passed).toBe(true);
  });

  it('review bug 1: a failed attempt is matched by score id and excluded, and counts under reliability', async () => {
    // Attempt 0 succeeds (0.9); attempt 1 crashes, and a scorer that returns 0 on no output scores it 0.
    const crashSecond = (_n: number) => 'ok' as const;
    const calls: Record<number, number> = {};
    const b = mockAgent('b', n => ((calls[n] = (calls[n] ?? -1) + 1) === 1 ? 'throw' : crashSecond(n)), () => 0.9);
    const zeroOnMissing = qualityScorer('quality', { onMissing: 'zero' });
    const m = mastraWith({ a: mockAgent('a', undefined, () => 0.9), b }, { quality: zeroOnMissing });
    const ds = await dataset(m, 6);
    const { items } = await ds.listItems();
    const run = async (target: string, attempts: number) => {
      const { experimentId } = await ds.createExperiment({ targetType: 'agent', targetId: target, scorers: ['quality'] });
      for (const item of items) for (let attempt = 0; attempt < attempts; attempt++) await ds.runExperimentItem({ experimentId, itemId: item.id, attempt });
      await ds.finalizeExperiment({ experimentId });
      return experimentId;
    };
    const A = await run('a', 2);
    const B = await run('b', 2);
    const ours = await gate(m, { baseline: A, candidate: B });
    expect(ours.scorers.quality!.change).toBeCloseTo(0, 10); // the 0s from crashed attempts are excluded
    expect(ours.reliability.newFailures).toBe(6);
    expect(ours.reasons.map(r => r.kind)).toEqual(['reliability']);
    expect(ours.warnings.some(w => w.includes('could not be matched'))).toBe(false);
  });
});
