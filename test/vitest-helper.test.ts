import { describe, expect, it } from 'vitest';
import { gate } from '../src/index.js';
import { expectGate, GateFailedError, registerGateMatchers } from '../src/vitest.js';
import { dataset, mastraWith, mockAgent, qualityScorer } from './helpers.js';

registerGateMatchers();

async function twoRuns(candidateCrashes: boolean) {
  const hardIsLow = (n: number) => (n >= 8 ? 0.3 : 0.9);
  const m = mastraWith({
    a: mockAgent('a', undefined, hardIsLow),
    b: mockAgent('b', n => (candidateCrashes && n >= 8 ? 'throw' : 'ok'), hardIsLow),
  });
  const ds = await dataset(m);
  const A = await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers: [qualityScorer()] });
  const B = await ds.startExperiment({ targetType: 'agent', targetId: 'b', scorers: [qualityScorer()] });
  return { m, baseline: A.experimentId, candidate: B.experimentId };
}

describe('vitest helpers', () => {
  it('expectGate().toPass() resolves with the comparison when the gate passes', async () => {
    const { m, baseline, candidate } = await twoRuns(false);
    const c = await expectGate(m, { baseline, candidate }).toPass();
    expect(c.passed).toBe(true);
  });

  it('expectGate().toPass() throws GateFailedError with the report when it fails', async () => {
    const { m, baseline, candidate } = await twoRuns(true);
    const err = await expectGate(m, { baseline, candidate }).toPass().catch(e => e);
    expect(err).toBeInstanceOf(GateFailedError);
    expect(err.message).toContain('3 item(s) fail in the candidate');
    expect(err.comparison.reliability.newFailures).toBe(3);
  });

  it('toPassEvalGate() matcher, both ways', async () => {
    const ok = await twoRuns(false);
    expect(await gate(ok.m, ok)).toPassEvalGate();
    const bad = await twoRuns(true);
    expect(await gate(bad.m, bad)).not.toPassEvalGate();
    expect(() => expect({}).toPassEvalGate()).toThrow('expected the result of gate()');
  });
});
