import * as L from './lib.mjs';
const { J } = L;
// flaky agent: attempt 0 scores 0.9, attempt 1 scores 0.1, attempt 2 scores 0.2 for every item
const flaky = L.mkAgent('flaky', undefined, (n, call) => [0.9, 0.1, 0.2][call] ?? 0.2);
const stable = L.mkAgent('stable', undefined, () => 0.4);
const quality = L.mkScorer('quality');
const m = L.mkMastra({ flaky, stable }, { quality });
const { ds, items } = await L.mkDataset(m, 4);
const ids = items.map(i => i.id);
const mk = async (target, attempts) => {
  const { experimentId } = await ds.createExperiment({ targetType: 'agent', targetId: target, scorers: ['quality'] });
  for (const id of ids) for (let a = 0; a < attempts; a++) await ds.runExperimentItem({ experimentId, itemId: id, attempt: a });
  await ds.finalizeExperiment({ experimentId });
  return experimentId;
};
const e1 = await mk('flaky', 3);
const d = await L.dump(m, e1);
J({ resultRows: d.results.length, attempts: [...new Set(d.results.map(r => r.attempt))], scoreRows: d.scores.length, scoreRowsPerItem: Object.fromEntries(ids.map((id, i) => ['q' + (i + 1), d.scores.filter(s => s.entityId === id).map(s => s.score)])) });
const trueMeanAllAttempts = d.scores.reduce((s, x) => s + x.score, 0) / d.scores.length;
const base = await mk('stable', 1);
const c = await L.compareExperiments(m, { experimentIdA: base, experimentIdB: e1 });
const q = c.scorers.quality;
J({ allRowsMean: trueMeanAllAttempts, compare_statsB: q.statsB, compare_statsA: q.statsA, hasRegression: c.hasRegression, delta: q.delta });
// order sensitivity: which score is "last"
J({ storedOrderForQ1: d.scores.filter(s => s.entityId === ids[0]).map(s => ({ score: s.score, createdAt: String(s.createdAt) })) });
// NEG CONTROL: single attempt per item -> compare mean equals row mean
const e2 = await mk('stable', 1);
const c2 = await L.compareExperiments(m, { experimentIdA: base, experimentIdB: e2 });
J({ NEG_CONTROL_single_attempt: { hasRegression: c2.hasRegression, delta: c2.scorers.quality.delta, totalItems: c2.scorers.quality.statsB.totalItems } });
process.exit(0);
