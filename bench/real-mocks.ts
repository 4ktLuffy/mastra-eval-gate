/**
 * How much do Mastra's tool mocks reduce run-to-run noise, and how many items does that save?
 *
 * The 30 problems from real-dataset.ts, except the starting stock is not in the question: the agent
 * must fetch it with a `lookupStock` tool. Agent: Codex gpt-5.6-luna @ effort none, through the
 * tool-calling path of bench/codex-model.ts. Scorer: exact answer (no judge, to keep noise from
 * the agent and the tool only).
 *
 *   L1-L3  live tool, which fails with a 503 on 30% of calls (SIMULATED flakiness, like a real API)
 *   M1-M3  the same items with Mastra `toolMocks` serving the correct tool output
 *
 * For each condition: per-item outcome flips across runs, Mastra's verdict and the gate's on the 6
 * ordered no-change pairs, the paired SD, and the items needed to detect a 0.1 drop.
 *
 *   npx tsx bench/real-mocks.ts   (about 360+ Codex calls)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { compareExperiments } from '@mastra/core/datasets';
import { createScorer } from '@mastra/core/evals';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { getAssistantMessageFromRunOutput } from '@mastra/evals/scorers/utils';
import { z } from 'zod';
import { compareRows, loadExperimentRows, mean, normalQuantile, sd, type ExperimentRows } from '../src/index.js';
import { codexModel, SECONDS, TOKENS } from './codex-model.js';
import { lastInteger, problems } from './real-dataset.js';

const OUT = process.env.OUT ?? 'results/real';
mkdirSync(OUT, { recursive: true });
const MODEL = { model: 'gpt-5.6-luna', effort: 'none' as const };
const FLAKE = 0.3;
const RUNS = Number(process.env.RUNS ?? 3);

const items = problems(30)
  .slice(0, Number(process.env.N ?? 30))
  .map((p, i) => {
    const m = p.question.match(/^A warehouse starts with (\d+) (\w+)\. /)!;
    const code = `W-${101 + i}`;
    return {
      ...p,
      code,
      start: Number(m[1]),
      question: p.question.replace(m[0], `Look up the starting number of ${m[2]} in warehouse ${code} with the lookupStock tool. `).replace('in the warehouse at the end', `in warehouse ${code} at the end`),
    };
  });
const startOf = new Map(items.map(i => [i.code, i.start]));

let liveCalls = 0, liveErrors = 0;
const lookupStock = createTool({
  id: 'lookupStock',
  description: 'Returns the starting stock count of a warehouse, by warehouse code (e.g. "W-101").',
  inputSchema: z.object({ warehouse: z.string() }),
  outputSchema: z.object({ warehouse: z.string(), start: z.number() }),
  execute: async ({ warehouse }) => {
    liveCalls++;
    if (Math.random() < FLAKE) {
      liveErrors++;
      throw new Error('503 Service Unavailable');
    }
    const start = startOf.get(warehouse.trim());
    if (start === undefined) throw new Error(`unknown warehouse ${warehouse}`);
    return { warehouse, start };
  },
});

const exact = createScorer({ id: 'exact', name: 'exact', description: 'final integer equals the answer' }).generateScore(({ run }) => {
  const reply = getAssistantMessageFromRunOutput(run.output) ?? '';
  if (!reply) throw new Error('no reply to score');
  return lastInteger(reply) === Number(run.groundTruth) ? 1 : 0;
});

const agent = new Agent({
  id: 'solver',
  name: 'solver',
  instructions: 'Solve the problem. Use the lookupStock tool to get the starting stock. End your reply with the final number.',
  model: codexModel(MODEL),
  tools: { lookupStock },
});
const mastra = new Mastra({ storage: new InMemoryStore(), agents: { solver: agent }, logger: false });

const live = await mastra.datasets.create({ name: 'live' });
await live.addItems({ items: items.map(i => ({ input: i.question, groundTruth: String(i.answer), metadata: { id: i.id, steps: i.steps } })) });
const mocked = await mastra.datasets.create({ name: 'mocked' });
await mocked.addItems({
  items: items.map(i => ({
    input: i.question,
    groundTruth: String(i.answer),
    metadata: { id: i.id, steps: i.steps },
    toolMocks: [{ toolName: 'lookupStock', args: {}, output: { warehouse: i.code, start: i.start }, matchArgs: 'ignore' as const }],
  })),
});

const runs: Record<string, { id: string; failed: number }> = {};
for (const [cond, ds] of [['L', live], ['M', mocked]] as const) {
  for (let k = 1; k <= RUNS; k++) {
    const name = `${cond}${k}`;
    const before = { calls: liveCalls, errors: liveErrors };
    const r = await ds.startExperiment({ targetType: 'agent', targetId: 'solver', scorers: [exact], maxConcurrency: 4 });
    runs[name] = { id: r.experimentId, failed: r.failedCount };
    const rows = await loadExperimentRows(mastra, r.experimentId);
    const outputs = r.results.map(x => ({
      itemId: x.itemId,
      text: (x.output as { text?: string } | null)?.text ?? null,
      toolCalls: (x.output as { toolCalls?: unknown[] } | null)?.toolCalls?.length ?? 0,
      error: x.error ? String((x.error as { message?: string }).message ?? x.error).split('\n    at ')[0]! : null,
    }));
    const tool = { calls: liveCalls - before.calls, errors: liveErrors - before.errors };
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ name, condition: cond === 'L' ? `live tool, ${FLAKE * 100}% simulated 503s` : 'toolMocks', tool, rows, outputs }, null, 2));
    console.log(JSON.stringify({ name, succeeded: r.succeededCount, failed: r.failedCount, tool, calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0) }));
  }
}

const zSum = normalQuantile(0.95) + normalQuantile(0.8);
const summary: Record<string, unknown> = {
  model: `codex ${MODEL.model} @ effort ${MODEL.effort}`,
  flakiness: `${FLAKE * 100}% of live lookupStock calls throw (simulated)`,
  codex: { calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0), medianSeconds: SECONDS.sort((x, y) => x - y)[Math.floor(SECONDS.length / 2)] },
  runs,
};
for (const cond of ['L', 'M'] as const) {
  const names = Array.from({ length: RUNS }, (_, k) => `${cond}${k + 1}`);
  const rows: Record<string, ExperimentRows> = {};
  for (const n of names) rows[n] = await loadExperimentRows(mastra, runs[n]!.id);
  // Per item: outcome in each run (1 / 0 / missing). A flip = not the same outcome in every run.
  const byItem = new Map<string, Array<number | null>>();
  names.forEach((n, k) => {
    for (const r of rows[n]!.results) {
      const s = rows[n]!.scores.find(x => x.entityId === r.itemId && x.scorerId === 'exact');
      const list = byItem.get(r.itemId) ?? Array(names.length).fill(null);
      list[k] = r.error ? null : (s?.score ?? null);
      byItem.set(r.itemId, list);
    }
  });
  const flips = [...byItem.values()].filter(v => new Set(v.map(x => (x === null ? 'x' : String(x)))).size > 1).length;
  const pairs = [];
  const diffs: number[] = [];
  for (const a of names)
    for (const b of names) {
      if (a === b) continue;
      const old = await compareExperiments(mastra, { experimentIdA: runs[a]!.id, experimentIdB: runs[b]!.id });
      const g = compareRows(rows[a]!, rows[b]!);
      pairs.push({ pair: `${a}->${b}`, mastraRegression: old.hasRegression, mastraDelta: old.scorers.exact?.delta, gatePassed: g.passed, reasons: g.reasons.map(x => x.message) });
      if (a < b) {
        const A = new Map(rows[a]!.scores.map(s => [s.entityId, s.score as number]));
        for (const s of rows[b]!.scores) if (A.has(s.entityId) && s.score != null) diffs.push(s.score - A.get(s.entityId)!);
      }
    }
  const pairedSd = sd(diffs);
  summary[cond === 'L' ? 'live' : 'mocked'] = {
    itemsWithFlippingOutcome: `${flips} of ${byItem.size}`,
    meanAccuracy: names.map(n => mean(rows[n]!.scores.filter(s => s.scorerId === 'exact').map(s => s.score as number))),
    failedItems: names.map(n => runs[n]!.failed),
    noChangePairs: { total: pairs.length, mastraFlagged: pairs.filter(p => p.mastraRegression).length, gateFailed: pairs.filter(p => !p.gatePassed).length },
    pairedSd,
    itemsToDetect0_1Drop: Math.ceil((zSum * pairedSd / 0.1) ** 2),
    pairs,
  };
}
writeFileSync(`${OUT}/mocks-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ live: (summary.live as Record<string, unknown>)?.noChangePairs, mocked: (summary.mocked as Record<string, unknown>)?.noChangePairs }));
process.exit(0);
