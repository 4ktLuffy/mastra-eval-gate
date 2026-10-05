// G5 with Mastra's OWN prebuilt code scorers (no LLM judge): when the agent run fails,
// is the failed item scored (0) or silently dropped from compareExperiments?
import * as L from './lib.mjs';
import {
  createCompletenessScorer,
  createContentSimilarityScorer,
  createKeywordCoverageScorer,
  createTextualDifferenceScorer,
  createToneScorer,
} from '@mastra/evals/scorers/prebuilt';

const { J } = L;
const scorers = {
  completeness: createCompletenessScorer(),
  contentSimilarity: createContentSimilarityScorer(),
  keywordCoverage: createKeywordCoverageScorer(),
  textualDifference: createTextualDifferenceScorer(),
  tone: createToneScorer(),
};

async function scenario(label, bBehavior) {
  const A = L.mkAgent('agentA'), B = L.mkAgent('agentB', bBehavior);
  const m = L.mkMastra({ agentA: A, agentB: B });
  const { ds } = await L.mkDataset(m);
  const list = Object.values(scorers);
  const sa = await L.run(ds, 'agentA', list);
  const sb = await L.run(ds, 'agentB', list);
  const d = await L.dump(m, sb.experimentId);
  const cmp = await L.compareExperiments(m, { experimentIdA: sa.experimentId, experimentIdB: sb.experimentId });
  console.log(`\n=== ${label} ===`);
  J({ B_failed: sb.failedCount, B_scoreRowsByScorer: Object.fromEntries(list.map(s => [s.id, d.scores.filter(r => r.scorerId === s.id).length])) });
  J({ B_failedItemScorerResults: sb.results.filter(r => r.error).slice(0, 1).map(r => r.scores.map(s => ({ id: s.scorerId, score: s.score, error: s.error ? String(s.error.message ?? s.error).slice(0, 80) : null }))) });
  J({ hasRegression: cmp.hasRegression, warnings: cmp.warnings });
  for (const [id, c] of Object.entries(cmp.scorers))
    J({ scorer: id, nA: c.statsA.totalItems, nB: c.statsB.totalItems, meanA: +c.statsA.avgScore.toFixed(3), meanB: +c.statsB.avgScore.toFixed(3), errorRateB: c.statsB.errorRate, delta: +c.delta.toFixed(3), regressed: c.regressed });
}

await scenario('B throws on q8-q10 (prebuilt code scorers)', n => (n >= 8 ? 'throw' : 'ok'));
await scenario('NEG CONTROL: B identical to A', () => 'ok');
process.exit(0);
