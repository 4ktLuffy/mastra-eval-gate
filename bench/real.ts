/**
 * Real-model run: a Mastra agent on Codex (gpt-5.6-luna, reasoning effort none) answering 30
 * multi-step arithmetic problems, scored by an exact-answer code scorer and a Codex LLM judge.
 *
 *   R1-R4  the same configuration, four times: every comparison between them is "no change"
 *   R5     the same configuration with itemTimeout 20 s (Codex calls took 12-25 s in a pilot; a
 *          15 s timeout killed every item at concurrency 4 in a dry run)
 *
 * For every ordered pair it records Mastra's compareExperiments verdict next to the gate's, and it
 * saves every row (outputs included) to results/real/ so the verdicts can be recomputed offline.
 *
 *   npx tsx bench/real.ts      (about 300 Codex calls; ~20-25 min; needs Codex signed in)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { compareExperiments } from '@mastra/core/datasets';
import { createScorer } from '@mastra/core/evals';
import { InMemoryStore } from '@mastra/core/storage';
import { getAssistantMessageFromRunOutput, getUserMessageFromRunInput } from '@mastra/evals/scorers/utils';
import { compareRows, loadExperimentRows, type ExperimentRows } from '../src/index.js';
import { codexModel, SECONDS, TOKENS } from './codex-model.js';
import { lastInteger, problems } from './real-dataset.js';

const OUT = process.env.OUT ?? 'results/real';
mkdirSync(OUT, { recursive: true });
const MODEL = { model: 'gpt-5.6-luna', effort: 'none' as const };
const PROBLEMS = problems(30).slice(0, Number(process.env.N ?? 30));

const exact = createScorer({ id: 'exact', name: 'exact', description: 'final integer equals the answer' }).generateScore(({ run }) => {
  const reply = getAssistantMessageFromRunOutput(run.output) ?? '';
  if (!reply) throw new Error('no reply to score');
  return lastInteger(reply) === Number(run.groundTruth) ? 1 : 0;
});

const judge = createScorer({
  id: 'judge',
  name: 'judge',
  description: 'LLM judge: is the final answer correct?',
  judge: {
    model: codexModel(MODEL),
    instructions: 'You grade answers to arithmetic word problems. Work the problem out yourself, then decide whether the reply ends with the correct final number.',
  },
  type: 'agent',
})
  .analyze({
    description: 'Decide correctness',
    outputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' }, correct: { type: 'boolean' } },
      required: ['reason', 'correct'],
    },
    createPrompt: ({ run }) =>
      `Problem:\n${getUserMessageFromRunInput(run.input) ?? ''}\n\nReply to grade:\n${getAssistantMessageFromRunOutput(run.output) ?? ''}\n\nIs the reply's final number the correct answer?`,
  })
  .generateScore(({ results }) => ((results.analyzeStepResult as { correct: boolean }).correct ? 1 : 0));

const agent = new Agent({
  id: 'solver',
  name: 'solver',
  instructions: 'Solve the problem. End your reply with the final number.',
  model: codexModel(MODEL),
});
const mastra = new Mastra({ storage: new InMemoryStore(), agents: { solver: agent }, logger: false });

const ds = await mastra.datasets.create({ name: 'warehouse-arithmetic' });
await ds.addItems({ items: PROBLEMS.map(p => ({ input: p.question, groundTruth: String(p.answer), metadata: { id: p.id, steps: p.steps } })) });

const runs: Array<{ name: string; id: string; seconds: number; failed: number }> = [];
for (const [name, extra] of [
  ['R1', {}],
  ['R2', {}],
  ['R3', {}],
  ['R4', {}],
  ['R5', { itemTimeout: 20_000 }],
] as const) {
  const t = Date.now();
  const r = await ds.startExperiment({ targetType: 'agent', targetId: 'solver', scorers: [exact, judge], maxConcurrency: 4, ...extra });
  const seconds = (Date.now() - t) / 1000;
  runs.push({ name, id: r.experimentId, seconds, failed: r.failedCount });
  const rows = await loadExperimentRows(mastra, r.experimentId);
  const outputs = r.results.map(x => {
    const t = x as { startedAt?: Date | string; completedAt?: Date | string };
    const seconds = t.startedAt && t.completedAt ? (new Date(t.completedAt).getTime() - new Date(t.startedAt).getTime()) / 1000 : null;
    // Keep the message, not the stack (it holds local paths).
    const error = x.error ? String((x.error as { message?: string }).message ?? x.error).split('\n    at ')[0]! : null;
    return { itemId: x.itemId, seconds, output: x.output, error };
  });
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ name, config: { ...MODEL, ...extra }, seconds, rows, outputs }, null, 2));
  console.log(JSON.stringify({ name, seconds, succeeded: r.succeededCount, failed: r.failedCount, calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0) }));
}

type PairResult = {
  baseline: string;
  candidate: string;
  mastra: { hasRegression: boolean; deltas: Record<string, number>; errorRateB: Record<string, number>; warnings: string[] };
  gate: { passed: boolean; reasons: string[]; changes: Record<string, number>; pAdjusted: Record<string, number> };
};
const pairs: PairResult[] = [];
const rowsOf: Record<string, ExperimentRows> = {};
for (const r of runs) rowsOf[r.name] = await loadExperimentRows(mastra, r.id);
for (const a of runs)
  for (const b of runs) {
    if (a === b || a.name === 'R5') continue;
    const old = await compareExperiments(mastra, { experimentIdA: a.id, experimentIdB: b.id });
    const g = compareRows(rowsOf[a.name]!, rowsOf[b.name]!);
    pairs.push({
      baseline: a.name,
      candidate: b.name,
      mastra: {
        hasRegression: old.hasRegression,
        deltas: Object.fromEntries(Object.entries(old.scorers).map(([k, v]) => [k, v.delta])),
        errorRateB: Object.fromEntries(Object.entries(old.scorers).map(([k, v]) => [k, v.statsB.errorRate])),
        warnings: old.warnings,
      },
      gate: {
        passed: g.passed,
        reasons: g.reasons.map(x => x.message),
        changes: Object.fromEntries(Object.entries(g.scorers).map(([k, v]) => [k, v.change])),
        pAdjusted: Object.fromEntries(Object.entries(g.scorers).map(([k, v]) => [k, v.pAdjusted])),
      },
    });
  }

const aa = pairs.filter(p => p.candidate !== 'R5');
const summary = {
  model: `codex ${MODEL.model} @ effort ${MODEL.effort} (agent and judge)`,
  items: PROBLEMS.length,
  runs,
  codex: { calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0), medianSeconds: SECONDS.sort((x, y) => x - y)[Math.floor(SECONDS.length / 2)] },
  noChange: { pairs: aa.length, mastraFlagged: aa.filter(p => p.mastra.hasRegression).length, gateFailed: aa.filter(p => !p.gate.passed).length },
  timeout: pairs.filter(p => p.candidate === 'R5'),
  pairs,
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ noChange: summary.noChange, timeout: summary.timeout.map(p => ({ base: p.baseline, mastra: p.mastra.hasRegression, deltas: p.mastra.deltas, gate: p.gate.passed, reasons: p.gate.reasons })) }, null, 1));
process.exit(0);
