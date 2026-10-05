import * as L from './lib.mjs';
const { J } = L;
const A = L.mkAgent('agentA'), B = L.mkAgent('agentB');
const m = L.mkMastra({ agentA: A, agentB: B });
const { ds, items } = await L.mkDataset(m);
const nm = L.nameOf(items);
const sa = await L.run(ds, 'agentA', [L.mkScorer('quality')]);
const sb = await L.run(ds, 'agentB', [L.mkScorer('quality', { throwOn: n => n >= 8 })]);   // scorer (e.g. judge) throws on q8-q10
const d = await L.dump(m, sb.experimentId);
J({ B_scoreRows: d.scores.length, B_inMemoryScorerResultsForQ8: sb.results.find(r => nm[r.itemId] === 'q8').scores, summaryFailedCount: sb.failedCount });
const c = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb.experimentId });
const q = c.scorers.quality;
J({ hasRegression: c.hasRegression, delta: q.delta, statsA: q.statsA, statsB: q.statsB });
// Can a null-score ROW exist at all? Write one directly to the scores store and see compare's errorRate:
const ss = await m.getStorage().getStore('scores');
const rows = d.scores; 
const first = rows[0];
await ss.saveScore({ ...first, id: undefined, score: null, entityId: 'x-null', createdAt: undefined, updatedAt: undefined }).then(() => J({ directNullSave: 'accepted' }), e => J({ directNullSave: 'rejected', msg: String(e.message).slice(0, 160) }));
const c3 = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb.experimentId });
J({ after_null_row: { errorRate: c3.scorers.quality.statsB.errorRate, errorCount: c3.scorers.quality.statsB.errorCount, avg: c3.scorers.quality.statsB.avgScore } });
process.exit(0);
