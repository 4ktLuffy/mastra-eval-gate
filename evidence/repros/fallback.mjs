import { Agent } from '@mastra/core/agent';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';

const calls = { primary: 0, fallback: 0 };
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const primary = new MockLanguageModelV2({
  modelId: 'primary',
  doStream: async () => { calls.primary++; return { stream: simulateReadableStream({ chunks: [
    { type: 'stream-start', warnings: [] },
    { type: 'error', error: { type: 'too_many_requests', code: 'rate_limit_exceeded' } },
    { type: 'finish', finishReason: 'error', usage },
  ] }) }; },
});
const fallback = new MockLanguageModelV2({
  modelId: 'fallback',
  doStream: async () => { calls.fallback++; return { stream: simulateReadableStream({ chunks: [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hello from fallback' }, { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage },
  ] }) }; },
});
// negative control: primary THROWS (headers-level failure) -> chain should advance
const thrower = new MockLanguageModelV2({ modelId: 'thrower', doStream: async () => { calls.primary++; throw new Error('boom 503'); } });

for (const [label, first] of [['in-band error chunk', primary], ['thrown error (control)', thrower]]) {
  calls.primary = 0; calls.fallback = 0;
  const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model: [{ model: first, maxRetries: 0 }, { model: fallback, maxRetries: 0 }] });
  let text = '', err;
  try { const out = await agent.stream('hi'); text = await out.text; err = out.error; } catch (e) { err = e; }
  console.log(label, JSON.stringify({ ...calls, text, err: err ? String(err.message ?? err).slice(0, 80) : null }));
}
