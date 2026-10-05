import * as L from './lib.mjs';
const { J } = L;
// A: scores q1..q10 (easy 0.9, hard q8-q10 0.3). B: every item scores +0.05 vs A, but B only runs q8-q10 (the hard ones).
const A = L.mkAgent('agentA'), B = L.mkAgent('agentB', undefined, n => +(L.SCORE_OF(n) + 0.05).toFixed(2));
const m = L.mkMastra({ agentA: A, agentB: B });
const { ds, items } = await L.mkDataset(m);
const nm = L.nameOf(items);
const sc = L.mkScorer('quality');
const sa = await L.run(ds, 'agentA', [sc]);
// B: unpaired subset via item scoping: inline-data run using SAME item ids (runExperiment with `data`)
const { runExperiment } = await import('@mastra/core/datasets');
const subset = items.filter(i => +i.input.slice(1) >= 8).map(i => ({ id: i.id, input: i.input, groundTruth: i.groundTruth }));
const sb = await runExperiment(m, { data: subset, targetType: 'agent', targetId: 'agentB', scorers: [sc] });
const cmp = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb.experimentId });
const q = cmp.scorers.quality;
J({ hasRegression: cmp.hasRegression, regressed: q.regressed, delta: q.delta, meanA: q.statsA.avgScore, meanB: q.statsB.avgScore, nA: q.statsA.totalItems, nB: q.statsB.totalItems, warnings: cmp.warnings });
const both = cmp.items.filter(i => i.inBothExperiments);
J({ overlapN: both.length, perItem: both.map(i => ({ item: nm[i.itemId], A: i.scoresA.quality, B: i.scoresB.quality })) });
J({ pairedMeanDelta: both.reduce((s, i) => s + (i.scoresB.quality - i.scoresA.quality), 0) / both.length, everyItemBgeA: both.every(i => i.scoresB.quality >= i.scoresA.quality) });
J({ itemsOnlyInA: cmp.items.filter(i => !i.inBothExperiments).length });
// NEG CONTROL: B runs all 10 with same +0.05 -> no regression
const sb2 = await L.run(ds, 'agentB', [sc]);
const c2 = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb2.experimentId });
J({ NEG_CONTROL_fullset: { hasRegression: c2.hasRegression, delta: c2.scorers.quality.delta, nB: c2.scorers.quality.statsB.totalItems } });
// Variant on a real dataset: delete q1-q7 (version bump), run B on the remaining 3 items of the same dataset
await ds.deleteItems({ itemIds: items.filter(i => +i.input.slice(1) < 8).map(i => i.id) });
const sb3 = await L.run(ds, 'agentB', [sc]);
const c3 = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb3.experimentId });
J({ VARIANT_dataset_version_bump: { hasRegression: c3.hasRegression, delta: c3.scorers.quality.delta, nA: c3.scorers.quality.statsA.totalItems, nB: c3.scorers.quality.statsB.totalItems, warnings: c3.warnings } });
process.exit(0);
