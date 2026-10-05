/**
 * A customer-style benchmark on a real model, specified before it was run.
 *
 * WORKLOAD. A support agent for an online shop (Codex gpt-5.6-luna @ effort none, through
 * bench/codex-model.ts) answers 30 tickets with three tools: lookupOrder, issueRefund, escalate.
 * The policy in its instructions:
 *   1. Refund orders delivered within the last 30 days with a total of $100 or less.
 *   2. Orders over $100 must be escalated to a human, never refunded directly.
 *   3. Orders delivered more than 30 days ago: decline the refund politely; no refund, no escalation.
 *   4. Orders still in transit: give the status; no refund, no escalation.
 * Tickets (bench/support-tickets.ts, seeded): 10 refund, 8 escalate, 7 decline, 5 in transit.
 * Scorer: `action` = 1 when the agent's refund/escalate calls match the policy (tool, order, amount).
 *
 * SEEDED REGRESSION. The candidate prompt is the same minus rule 2. Only the 8 "escalate" tickets
 * can change, so at most 8/30 = 0.27 of accuracy can be lost; how much is lost is up to the model.
 *
 * RUNS. Baseline B1-B3 (6 ordered no-change pairs), regressed X1-X2 (6 baseline->regressed pairs).
 *
 * DECISION RULES, fixed in advance. Gate defaults (alpha 0.05, tolerance 0, reliability 'strict'),
 * plus the same with reliability 'statistical'; Mastra's compareExperiments with defaults. For every
 * pair we report both verdicts. A no-change pair flagged = false alarm; a regressed pair not flagged
 * = miss. Cost = Codex calls and tokens per run. Nothing is re-run or re-tuned after seeing results.
 *
 *   npx tsx bench/real-support.ts   (about 450 Codex calls)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { compareExperiments } from '@mastra/core/datasets';
import { createScorer } from '@mastra/core/evals';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { compareRows, loadExperimentRows, mean, type ExperimentRows } from '../src/index.js';
import { codexModel, SECONDS, TOKENS } from './codex-model.js';
import { allItems } from './real-dataset.js';
import { expectedAction, ORDERS, tickets } from './support-tickets.js';

const OUT = process.env.OUT ?? 'results/real';
mkdirSync(OUT, { recursive: true });
const MODEL = { model: 'gpt-5.6-luna', effort: 'none' as const };
const TICKETS = tickets().slice(0, Number(process.env.N ?? 30));
const BASELINE_RUNS = Number(process.env.B ?? 3);
const REGRESSED_RUNS = Number(process.env.X ?? 2);

const RULES = [
  '1. Refund orders delivered within the last 30 days with a total of $100 or less (use issueRefund with the full total).',
  '2. Orders over $100 must be escalated to a human with the escalate tool, never refunded directly.',
  '3. Orders delivered more than 30 days ago: decline the refund politely. Do not refund or escalate.',
  '4. Orders still in transit: tell the customer the status. Do not refund or escalate.',
];
const prompt = (rules: string[]) =>
  `You are the support agent for an online shop. Always look up the order with lookupOrder before deciding. Follow this policy:\n${rules.join('\n')}\nThen reply to the customer briefly.`;
const PROMPTS = { baseline: prompt(RULES), regressed: prompt(RULES.filter(r => !r.startsWith('2.'))) };

const lookupOrder = createTool({
  id: 'lookupOrder',
  description: 'Look up an order by id (e.g. "ORD-1001"). Returns total, status and days since delivery.',
  inputSchema: z.object({ orderId: z.string() }),
  outputSchema: z.object({ orderId: z.string(), total: z.number(), status: z.string(), deliveredDaysAgo: z.number().nullable() }),
  execute: async ({ orderId }) => {
    const o = ORDERS.get(orderId.trim());
    if (!o) throw new Error(`no order ${orderId}`);
    return { orderId: o.orderId, total: o.total, status: o.status, deliveredDaysAgo: o.deliveredDaysAgo };
  },
});
const issueRefund = createTool({
  id: 'issueRefund',
  description: 'Refund an order. Side effect: money is returned to the customer.',
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => ({ ok: true, orderId, amount }),
});
const escalate = createTool({
  id: 'escalate',
  description: 'Hand the ticket to a human agent, with a short reason.',
  inputSchema: z.object({ orderId: z.string(), reason: z.string() }),
  execute: async ({ orderId }) => ({ ok: true, orderId }),
});

/** Every tool invocation in the agent's output messages, with its arguments. */
function toolCallsWithArgs(output: unknown): Array<{ toolName: string; args: Record<string, unknown> }> {
  const found: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    if (typeof o.toolName === 'string' && o.args && typeof o.args === 'object' && (o.state === undefined || o.state === 'result' || o.state === 'call')) {
      found.push({ toolName: o.toolName, args: o.args as Record<string, unknown> });
    }
    Object.values(o).forEach(walk);
  };
  walk(output);
  // An invocation can appear twice (call and result); keep one per tool + args.
  return [...new Map(found.map(c => [`${c.toolName}:${JSON.stringify(c.args)}`, c])).values()];
}

/**
 * 1 when the agent's refund/escalate calls are what the policy requires for this ticket's order:
 * the right tool, on the right order, and for a refund the full order total. (The first run of this
 * benchmark, saved in results/real/SB*.json and SX*.json, used an earlier version that checked tool
 * names only; see FINDINGS.md.)
 */
const action = createScorer({ id: 'action', name: 'action', description: "agent's refund/escalate calls match the policy" }).generateScore(
  ({ run }) => {
    const [expected, orderId] = String(run.groundTruth).split(':') as ['refund' | 'escalate' | 'none', string];
    const calls = toolCallsWithArgs(run.output).filter(c => c.toolName === 'issueRefund' || c.toolName === 'escalate');
    if (expected === 'none') return calls.length === 0 ? 1 : 0;
    const order = ORDERS.get(orderId)!;
    const right = calls.filter(c =>
      expected === 'refund'
        ? c.toolName === 'issueRefund' && String(c.args.orderId).trim() === orderId && Number(c.args.amount) === order.total
        : c.toolName === 'escalate' && String(c.args.orderId).trim() === orderId,
    );
    return right.length === 1 && calls.length === 1 ? 1 : 0;
  },
);

const agentFor = (id: 'baseline' | 'regressed') =>
  new Agent({
    id,
    name: id,
    instructions: PROMPTS[id],
    model: codexModel(MODEL),
    tools: { lookupOrder, issueRefund, escalate },
    defaultOptions: { maxSteps: 6 },
  });
const mastra = new Mastra({ storage: new InMemoryStore(), agents: { baseline: agentFor('baseline'), regressed: agentFor('regressed') }, logger: false });
const ds = await mastra.datasets.create({ name: 'support-tickets' });
await ds.addItems({
  items: TICKETS.map(t => ({ input: t.text, groundTruth: `${expectedAction(t.orderId)}:${t.orderId}`, metadata: { ticket: t.id, kind: t.kind } })),
});
const questions = new Map((await allItems(ds)).map(i => [i.id, String(i.input)]));

const runs: Record<string, { id: string; calls: number; tokens: number; succeeded: number; failed: number }> = {};
const plan = [
  ...Array.from({ length: BASELINE_RUNS }, (_, k) => [`SB${k + 1}`, 'baseline'] as const),
  ...Array.from({ length: REGRESSED_RUNS }, (_, k) => [`SX${k + 1}`, 'regressed'] as const),
];
for (const [name, target] of plan) {
  const before = { calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0) };
  const r = await ds.startExperiment({ targetType: 'agent', targetId: target, scorers: [action], maxConcurrency: 4 });
  const cost = { calls: TOKENS.length - before.calls, tokens: TOKENS.reduce((a, b) => a + b, 0) - before.tokens };
  runs[name] = { id: r.experimentId, ...cost, succeeded: r.succeededCount, failed: r.failedCount };
  const rows = await loadExperimentRows(mastra, r.experimentId);
  const outputs = r.results.map(x => {
    const out = x.output as { text?: string; toolCalls?: Array<{ payload?: { toolName?: string }; toolName?: string }> } | null;
    return {
      itemId: x.itemId,
      ticket: questions.get(x.itemId),
      text: out?.text ?? null,
      tools: (out?.toolCalls ?? []).map(c => c.payload?.toolName ?? c.toolName),
      toolCalls: out?.toolCalls ?? [],
      error: x.error ? String((x.error as { message?: string }).message ?? x.error).split('\n    at ')[0]! : null,
    };
  });
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ name, config: { ...MODEL, prompt: PROMPTS[target] }, cost, rows, outputs }, null, 2));
  console.log(JSON.stringify({ name, target, succeeded: r.succeededCount, failed: r.failedCount, accuracy: mean(rows.scores.map(s => s.score as number)), ...cost }));
}

const rowsOf: Record<string, ExperimentRows> = {};
for (const [name, r] of Object.entries(runs)) rowsOf[name] = await loadExperimentRows(mastra, r.id);
const names = Object.keys(runs);
const B = names.filter(n => n.startsWith('SB')), X = names.filter(n => n.startsWith('SX'));
const pairs: Array<[string, string, 'no-change' | 'regressed']> = [
  ...B.flatMap(a => B.filter(b => b !== a).map(b => [a, b, 'no-change'] as [string, string, 'no-change'])),
  ...B.flatMap(a => X.map(x => [a, x, 'regressed'] as [string, string, 'regressed'])),
];
type PairResult = {
  pair: string;
  truth: 'no-change' | 'regressed';
  mastra: { hasRegression: boolean; delta: number | undefined };
  gate: { verdict: string; reasons: string[]; change: number | undefined; p: number | undefined; detects: number | undefined };
  gateStatistical: { verdict: string };
};
const results: PairResult[] = [];
for (const [a, b, truth] of pairs) {
  const old = await compareExperiments(mastra, { experimentIdA: runs[a]!.id, experimentIdB: runs[b]!.id });
  const strict = compareRows(rowsOf[a]!, rowsOf[b]!);
  const statistical = compareRows(rowsOf[a]!, rowsOf[b]!, { reliability: 'statistical' });
  results.push({
    pair: `${a}->${b}`,
    truth,
    mastra: { hasRegression: old.hasRegression, delta: old.scorers.action?.delta },
    gate: { verdict: strict.verdict, reasons: strict.reasons.map(r => r.message), change: strict.scorers.action?.change, p: strict.scorers.action?.pAdjusted, detects: strict.scorers.action?.minimumDetectable },
    gateStatistical: { verdict: statistical.verdict },
  });
}
const flagged = (r: PairResult, who: 'mastra' | 'gate' | 'gateStatistical') =>
  who === 'mastra' ? r.mastra.hasRegression : (who === 'gate' ? r.gate.verdict : r.gateStatistical.verdict) === 'fail';
const tally = (truth: string) => {
  const rs = results.filter(r => r.truth === truth);
  return {
    pairs: rs.length,
    mastraFlagged: rs.filter(r => flagged(r, 'mastra')).length,
    gateFailed: rs.filter(r => flagged(r, 'gate')).length,
    gateInsufficient: rs.filter(r => r.gate.verdict === 'insufficient').length,
    gateStatisticalFailed: rs.filter(r => flagged(r, 'gateStatistical')).length,
  };
};
const summary = {
  model: `codex ${MODEL.model} @ effort ${MODEL.effort}`,
  tickets: TICKETS.length,
  runs,
  codex: { calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0), medianSeconds: SECONDS.sort((x, y) => x - y)[Math.floor(SECONDS.length / 2)] },
  noChange: tally('no-change'),
  regressed: tally('regressed'),
  results,
};
writeFileSync(`${OUT}/support-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ noChange: summary.noChange, regressed: summary.regressed }, null, 1));
process.exit(0);
