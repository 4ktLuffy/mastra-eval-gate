/**
 * Real detection: a regression teams actually ship, lowering reasoning effort to save cost.
 *
 *   MED   the agent at reasoning effort "medium"   (baseline)
 *   NONE  the same agent and prompt at effort "none" (candidate)
 *
 * Same Mastra instance and dataset, exact-answer scorer, Codex gpt-5.6-luna. Mastra's
 * compareExperiments and the gate run on the same stored rows.
 *
 *   npx tsx bench/real-effort.ts   (60 Codex calls)
 */
import { writeFileSync } from 'node:fs';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { compareExperiments } from '@mastra/core/datasets';
import { createScorer } from '@mastra/core/evals';
import { InMemoryStore } from '@mastra/core/storage';
import { getAssistantMessageFromRunOutput } from '@mastra/evals/scorers/utils';
import { compareRows, loadExperimentRows } from '../src/index.js';
import { codexModel, TOKENS } from './codex-model.js';
import { allItems, lastInteger, problems } from './real-dataset.js';

const PROMPT = 'Solve the problem. End your reply with the final number.';
const exact = createScorer({ id: 'exact', name: 'exact', description: 'final integer equals the answer' }).generateScore(({ run }) => {
  const reply = getAssistantMessageFromRunOutput(run.output) ?? '';
  if (!reply) throw new Error('no reply to score');
  return lastInteger(reply) === Number(run.groundTruth) ? 1 : 0;
});
const agent = (effort: 'medium' | 'none') =>
  new Agent({ id: effort, name: effort, instructions: PROMPT, model: codexModel({ model: 'gpt-5.6-luna', effort }) });
const mastra = new Mastra({ storage: new InMemoryStore(), agents: { medium: agent('medium'), none: agent('none') }, logger: false });
const ds = await mastra.datasets.create({ name: 'warehouse-arithmetic' });
await ds.addItems({ items: problems(30).map(p => ({ input: p.question, groundTruth: String(p.answer), metadata: { id: p.id, steps: p.steps } })) });
const questions = new Map((await allItems(ds)).map(i => [i.id, String(i.input)]));

const ids: Record<string, string> = {};
for (const [name, target] of [['MED', 'medium'], ['NONE', 'none']] as const) {
  const r = await ds.startExperiment({ targetType: 'agent', targetId: target, scorers: [exact], maxConcurrency: 4 });
  ids[name] = r.experimentId;
  const outputs = r.results.map(x => ({
    itemId: x.itemId,
    question: questions.get(x.itemId),
    text: (x.output as { text?: string } | null)?.text ?? null,
    error: x.error ? String((x.error as { message?: string }).message ?? x.error).split('\n    at ')[0]! : null,
  }));
  writeFileSync(`results/real/${name}.json`, JSON.stringify({ name, config: { model: 'gpt-5.6-luna', effort: target, prompt: PROMPT }, rows: await loadExperimentRows(mastra, r.experimentId), outputs }, null, 2));
  console.log(JSON.stringify({ name, succeeded: r.succeededCount, failed: r.failedCount, calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0) }));
}

const old = await compareExperiments(mastra, { experimentIdA: ids.MED!, experimentIdB: ids.NONE! });
const g = compareRows(await loadExperimentRows(mastra, ids.MED!), await loadExperimentRows(mastra, ids.NONE!));
const q = g.scorers.exact!;
const summary = {
  model: 'codex gpt-5.6-luna; baseline effort medium, candidate effort none',
  codex: { calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0) },
  mastra: { hasRegression: old.hasRegression, delta: old.scorers.exact!.delta, meanA: old.scorers.exact!.statsA.avgScore, meanB: old.scorers.exact!.statsB.avgScore },
  gate: { passed: g.passed, reasons: g.reasons.map(r => r.message), n: q.pairedN, meanA: q.meanA, meanB: q.meanB, change: q.change, ci: q.changeCI, p: q.pAdjusted, regressed: q.regressed, minimumDetectable: q.minimumDetectable },
};
writeFileSync('results/real/effort-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
