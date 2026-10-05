/** Real Mastra experiments with scripted mock models (no network, no API keys). */
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createScorer } from '@mastra/core/evals';
import { MockLanguageModelV2 } from 'ai/test';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
type Behaviour = 'ok' | 'throw';

/** Item qN's answer carries a known quality score S=<x> so a code scorer can read it back. */
export function mockAgent(id: string, behaviour: (n: number) => Behaviour = () => 'ok', score: (n: number, call: number) => number) {
  const calls: Record<number, number> = {};
  const model = new MockLanguageModelV2({
    modelId: id,
    doGenerate: async ({ prompt }) => {
      const user = [...prompt].reverse().find(m => m.role === 'user')!;
      const q = (user.content as Array<{ text?: string }>).map(c => c.text ?? '').join('');
      const n = Number(q.replace(/\D/g, ''));
      calls[n] = (calls[n] ?? -1) + 1;
      if (behaviour(n) === 'throw') throw new Error(`503 upstream failure on ${q}`);
      return { content: [{ type: 'text', text: `ans(${q}) S=${score(n, calls[n]!)}` }], finishReason: 'stop', usage, warnings: [] };
    },
  });
  return new Agent({ id, name: id, instructions: 'x', model });
}

/** Reads S=<x> back; with no output it throws (default, as a careful scorer would) or returns 0. */
export function qualityScorer(id = 'quality', { onMissing = 'throw' }: { onMissing?: 'throw' | 'zero' } = {}) {
  return createScorer({ id, name: id, description: 'reads S=<x>' }).generateScore(({ run }) => {
    const m = JSON.stringify(run.output ?? null).match(/S=([\d.]+)/);
    if (!m) {
      if (onMissing === 'zero') return 0;
      throw new Error('no output to score');
    }
    return Number.parseFloat(m[1]!);
  });
}

export function mastraWith(agents: Record<string, Agent>, scorers: Record<string, ReturnType<typeof qualityScorer>> = {}) {
  return new Mastra({ storage: new InMemoryStore(), agents, scorers, logger: false });
}

export async function dataset(mastra: Mastra, n = 10) {
  const ds = await mastra.datasets.create({ name: `ds-${Math.random().toString(36).slice(2)}` });
  await ds.addItems({ items: Array.from({ length: n }, (_, i) => ({ input: `q${i + 1}`, groundTruth: `g${i + 1}` })) });
  return ds;
}
