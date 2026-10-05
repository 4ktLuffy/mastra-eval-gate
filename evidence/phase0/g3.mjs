import * as L from './lib.mjs';
const { J } = L;
const A = L.mkAgent('agentA'), B = L.mkAgent('agentB');
const tone = L.createScorer({ id: 'tone', description: 'tone', name: 'tone' }).generateScore(() => 0.8);        // higher-is-better
const harm = L.createScorer({ id: 'harm', description: 'harm', name: 'harm' }).generateScore(() => 0.4);        // lower-is-better
const quality = L.mkScorer('quality');
const m = L.mkMastra({ agentA: A, agentB: B });
const { ds } = await L.mkDataset(m);
const rA = await L.run(ds, 'agentA', [quality, tone, harm]);
const rB = await L.run(ds, 'agentB', [quality]);                 // tone+harm silently absent in B (e.g. scorer dropped from config)
const rBsame = await L.run(ds, 'agentB', [quality, tone, harm]); // NEG CONTROL: all scorers present
const th = { harm: { value: 0.05, direction: 'lower-is-better' } };
const pr = (label, c) => J({ label, hasRegression: c.hasRegression, warnings: c.warnings, scorers: Object.fromEntries(Object.entries(c.scorers).map(([k, v]) => [k, { meanA: +v.statsA.avgScore.toFixed(3), meanB: +v.statsB.avgScore.toFixed(3), nA: v.statsA.totalItems, nB: v.statsB.totalItems, delta: +v.delta.toFixed(3), regressed: v.regressed }])) });
pr('A has tone(hib)+harm(lib); B has neither', await L.compareExperiments(m, { experimentIdA: rA.experimentId, experimentIdB: rB.experimentId, thresholds: th }));
pr('REVERSED: B has tone+harm, A has neither (A=baseline lacks them)', await L.compareExperiments(m, { experimentIdA: rB.experimentId, experimentIdB: rA.experimentId, thresholds: th }));
pr('NEG CONTROL: both have all scorers', await L.compareExperiments(m, { experimentIdA: rA.experimentId, experimentIdB: rBsame.experimentId, thresholds: th }));
process.exit(0);
