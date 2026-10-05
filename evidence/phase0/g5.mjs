import * as L from './lib.mjs';
const { J } = L;
async function scenario(label, scorerOpts, bBehavior, extra = {}) {
  const A = L.mkAgent('agentA'), B = L.mkAgent('agentB', bBehavior);
  const m = L.mkMastra({ agentA: A, agentB: B });
  const { ds, items } = await L.mkDataset(m);
  const nm = L.nameOf(items);
  const sc = L.mkScorer('quality', scorerOpts);
  const sa = await L.run(ds, 'agentA', [sc]);
  const sb = await L.run(ds, 'agentB', [sc], extra);
  console.log(`\n=== ${label} ===`);
  J({ summaryA: { status: sa.status, total: sa.totalItems, succeeded: sa.succeededCount, failed: sa.failedCount }, summaryB: { status: sb.status, total: sb.totalItems, succeeded: sb.succeededCount, failed: sb.failedCount } });
  const d = await L.dump(m, sb.experimentId);
  J({ B_resultRows: d.results.length, B_scoreRows: d.scores.length, B_scoreRowItems: d.scores.map(s => nm[s.entityId]).sort() });
  J({ B_failedRowErrors: d.results.filter(r => r.error).map(r => ({ item: nm[r.itemId], error: r.error.message })) });
  J({ B_inMemorySummaryScores_for_failed: sb.results.filter(r => r.error).map(r => ({ item: nm[r.itemId], scores: r.scores.map(s => ({ score: s.score, error: s.error })) })) });
  J({ experimentRowCounts: { succeeded: d.experiment.succeededCount, failed: d.experiment.failedCount, total: d.experiment.totalItems, status: d.experiment.status } });
  const cmp = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb.experimentId });
  J({ hasRegression: cmp.hasRegression, warnings: cmp.warnings, delta: cmp.scorers.quality.delta, regressed: cmp.scorers.quality.regressed, statsA: cmp.scorers.quality.statsA, statsB: cmp.scorers.quality.statsB });
  J({ itemsNotInBoth: cmp.items.filter(i => !i.inBothExperiments).length, itemsInBothWithNullB: cmp.items.filter(i => i.scoresB.quality === null).map(i => nm[i.itemId]) });
  return cmp;
}
const hard = n => n >= 8 ? 'throw' : 'ok';
await scenario('G5a: B throws on q8-q10; scorer THROWS when output is null', { onMissing: 'throw' }, hard);
await scenario('G5b: B throws on q8-q10; scorer returns 0 when output is null', { onMissing: 'zero' }, hard);
await scenario('G5c: B HANGS on q8-q10 with itemTimeout (scorer throws on null)', { onMissing: 'throw' }, n => n >= 8 ? 'hang' : 'ok', { itemTimeout: 400 }).catch(e => console.log('ERR', e.message));
await scenario('NEG CONTROL: B identical to A', { onMissing: 'throw' }, () => 'ok');
process.exit(0);
