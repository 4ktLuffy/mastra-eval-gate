/**
 * Real detection run: does the gate catch a genuine quality drop on a real model?
 *
 *   B1, B2  the baseline agent from bench/real.ts (Codex gpt-5.6-luna @ effort none), twice
 *   D       the same agent with a shortened prompt that tells it not to work the problem out
 *
 * Same Mastra instance and dataset, so items pair. Scored by the exact-answer scorer and the Codex
 * judge. B1 vs B2 is the noise; B1 vs D and B2 vs D are the drop.
 *
 *   npx tsx bench/real-detect.ts   (about 180 Codex calls)
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
import { allItems, lastInteger, problems } from './real-dataset.js';

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
    outputSchema: { type: 'object', properties: { reason: { type: 'string' }, correct: { type: 'boolean' } }, required: ['reason', 'correct'] },
    createPrompt: ({ run }) =>
      `Problem:\n${getUserMessageFromRunInput(run.input) ?? ''}\n\nReply to grade:\n${getAssistantMessageFromRunOutput(run.output) ?? ''}\n\nIs the reply's final number the correct answer?`,
  })
  .generateScore(({ results }) => ((results.analyzeStepResult as { correct: boolean }).correct ? 1 : 0));

const PROMPTS = {
  baseline: 'Solve the problem. End your reply with the final number.',
  degraded: 'Reply with only the final number. Do not work the problem out or show any steps.',
};
const mastra = new Mastra({
  storage: new InMemoryStore(),
  agents: {
    baseline: new Agent({ id: 'baseline', name: 'baseline', instructions: PROMPTS.baseline, model: codexModel(MODEL) }),
    degraded: new Agent({ id: 'degraded', name: 'degraded', instructions: PROMPTS.degraded, model: codexModel(MODEL) }),
  },
  logger: false,
});
const ds = await mastra.datasets.create({ name: 'warehouse-arithmetic' });
await ds.addItems({ items: PROBLEMS.map(p => ({ input: p.question, groundTruth: String(p.answer), metadata: { id: p.id, steps: p.steps } })) });

const ids: Record<string, string> = {};
for (const name of ['B1', 'B2', 'D'] as const) {
  const target = name === 'D' ? 'degraded' : 'baseline';
  const r = await ds.startExperiment({ targetType: 'agent', targetId: target, scorers: [exact, judge], maxConcurrency: 4 });
  ids[name] = r.experimentId;
  const rows = await loadExperimentRows(mastra, r.experimentId);
  const questions = new Map((await allItems(ds)).map(i => [i.id, String(i.input)]));
  const outputs = r.results.map(x => ({
    itemId: x.itemId,
    question: questions.get(x.itemId),
    output: x.output,
    error: x.error ? String((x.error as { message?: string }).message ?? x.error).split('\n    at ')[0]! : null,
  }));
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ name, config: { ...MODEL, prompt: PROMPTS[target] }, rows, outputs }, null, 2));
  console.log(JSON.stringify({ name, succeeded: r.succeededCount, failed: r.failedCount, calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0) }));
}

const view = (c: ReturnType<typeof compareRows>) => ({
  passed: c.passed,
  reasons: c.reasons.map(x => x.message),
  scorers: Object.fromEntries(Object.entries(c.scorers).map(([k, v]) => [k, { n: v.pairedN, meanA: v.meanA, meanB: v.meanB, change: v.change, ci: v.changeCI, pAdjusted: v.pAdjusted, regressed: v.regressed }])),
});

// Same instance: Mastra's verdict next to the gate's, for every ordered pair.
const rows: Record<string, ExperimentRows> = {};
for (const [name, id] of Object.entries(ids)) rows[name] = await loadExperimentRows(mastra, id);
const pairs = [];
for (const [a, b] of [['B1', 'B2'], ['B2', 'B1'], ['B1', 'D'], ['B2', 'D']] as const) {
  const old = await compareExperiments(mastra, { experimentIdA: ids[a]!, experimentIdB: ids[b]! });
  pairs.push({
    baseline: a,
    candidate: b,
    mastra: { hasRegression: old.hasRegression, deltas: Object.fromEntries(Object.entries(old.scorers).map(([k, v]) => [k, v.delta])) },
    gate: view(compareRows(rows[a]!, rows[b]!)),
  });
}
writeFileSync(`${OUT}/detect-summary.json`, JSON.stringify({ model: `codex ${MODEL.model} @ effort ${MODEL.effort}`, prompts: PROMPTS, codex: { calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0), medianSeconds: SECONDS.sort((x, y) => x - y)[Math.floor(SECONDS.length / 2)] }, pairs }, null, 2));
console.log(JSON.stringify(pairs.map(p => ({ pair: `${p.baseline}->${p.candidate}`, mastra: p.mastra, gate: { passed: p.gate.passed, reasons: p.gate.reasons } }))));
process.exit(0);
