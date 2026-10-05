/**
 * Demo: two real Mastra experiments where the candidate agent crashes on its 3 hardest items.
 * Prints Mastra's compareExperiments verdict, then the gate's.
 *   npx tsx examples/crash-demo.ts
 */
import { compareExperiments } from '@mastra/core/datasets';
import { formatReport, gate } from '../src/index.js';
import { dataset, mastraWith, mockAgent, qualityScorer } from '../test/helpers.js';

const hardIsLow = (n: number) => (n >= 8 ? 0.3 : 0.9);
export const mastra = mastraWith({
  baseline: mockAgent('baseline', undefined, hardIsLow),
  candidate: mockAgent('candidate', n => (n >= 8 ? 'throw' : 'ok'), hardIsLow),
});

const ds = await dataset(mastra);
const A = await ds.startExperiment({ targetType: 'agent', targetId: 'baseline', scorers: [qualityScorer()] });
const B = await ds.startExperiment({ targetType: 'agent', targetId: 'candidate', scorers: [qualityScorer()] });

const old = await compareExperiments(mastra, { experimentIdA: A.experimentId, experimentIdB: B.experimentId });
const q = old.scorers.quality!;
console.log(`Mastra compareExperiments: hasRegression=${old.hasRegression}, quality ${q.statsA.avgScore.toFixed(2)} → ${q.statsB.avgScore.toFixed(2)} (delta ${q.delta >= 0 ? '+' : ''}${q.delta.toFixed(2)}), errorRate ${q.statsB.errorRate}, warnings ${JSON.stringify(old.warnings)}`);
console.log(`(the candidate failed ${B.failedCount} of ${B.totalItems} items)\n`);
console.log(formatReport(await gate(mastra, { baseline: A.experimentId, candidate: B.experimentId })));
process.exit(0);
