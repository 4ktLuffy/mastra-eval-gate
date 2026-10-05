import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createScorer } from '@mastra/core/evals';
import { compareExperiments } from '@mastra/core/datasets';
import { MockLanguageModelV2 } from 'ai/test';

export { compareExperiments, createScorer };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// Item "qN" has deterministic target score: hard items (8,9,10) -> 0.3, items 1..7 -> 0.9
export const SCORE_OF = n => (n >= 8 ? 0.3 : 0.9);
const lastUserText = prompt => {
  const u = [...prompt].reverse().find(m => m.role === 'user');
  return u.content.map(c => c.text ?? '').join('');
};
// behavior(n) -> 'ok' | 'throw' | 'hang'
export function mockModel(id, behavior = () => 'ok', scoreFn = (n) => SCORE_OF(n)) {
  const calls = {};
  return new MockLanguageModelV2({
    modelId: id,
    doGenerate: async ({ prompt, abortSignal }) => {
      const q = lastUserText(prompt); const n = +q.replace(/\D/g, '');
      calls[n] = (calls[n] ?? -1) + 1; const b = behavior(n);
      if (b === 'throw') throw new Error(`503 upstream failure on ${q}`);
      if (b === 'hang') await new Promise((_, rej) => abortSignal?.addEventListener('abort', () => rej(new Error('aborted: item timeout'))));
      return { content: [{ type: 'text', text: `ans(${q}) S=${scoreFn(n, calls[n])}` }], finishReason: 'stop', usage, warnings: [] };
    },
  });
}
export const mkAgent = (id, behavior, scoreFn) => new Agent({ id, name: id, instructions: 'x', model: mockModel(id, behavior, scoreFn) });

// deterministic code scorer: parses S=<x> from agent output text; onMissing: 'zero' | 'throw'
export function mkScorer(id = 'quality', { onMissing = 'throw', throwOn = () => false } = {}) {
  return createScorer({ id, description: 'deterministic', name: id }).generateScore(({ run }) => {
    const s = JSON.stringify(run.output ?? null);
    const m = s.match(/S=([\d.]+)/);
    const q = s.match(/ans\(q(\d+)\)/);
    if (q && throwOn(+q[1])) throw new Error('scorer boom on q' + q[1]);
    if (!m) { if (onMissing === 'throw') throw new Error('no output to score'); return 0; }
    return parseFloat(m[1]);
  });
}

export function mkMastra(agents, scorers = {}) {
  return new Mastra({ storage: new InMemoryStore(), agents, scorers, logger: false });
}
export async function mkDataset(mastra, n = 10, name = 'ds') {
  const ds = await mastra.datasets.create({ name });
  const items = await ds.addItems({ items: Array.from({ length: n }, (_, i) => ({ input: `q${i + 1}`, groundTruth: `g${i + 1}` })) });
  return { ds, items };
}
export const run = (ds, agentId, scorers, extra = {}) => ds.startExperiment({ targetType: 'agent', targetId: agentId, scorers, maxConcurrency: 4, ...extra });
export async function dump(mastra, expId) {
  const es = await mastra.getStorage().getStore('experiments');
  const ss = await mastra.getStorage().getStore('scores');
  const r = await es.listExperimentResults({ experimentId: expId, pagination: { page: 0, perPage: false } });
  const s = await ss.listScoresByRunId({ runId: expId, pagination: { page: 0, perPage: false } });
  return { results: r.results, scores: s.scores, experiment: await es.getExperimentById({ id: expId }) };
}
export const J = o => console.log(JSON.stringify(o));
export const nameOf = (items) => Object.fromEntries(items.map(i => [i.id, i.input]));
setInterval(() => {}, 1000); // keep loop alive: AbortSignal.timeout timers are unref'd
