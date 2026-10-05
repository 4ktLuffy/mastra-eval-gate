import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
export const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
export const t0 = Date.now();
export const T = () => Date.now() - t0;
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const text = (s) => [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: s }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }];
const toolcall = (name, args, id = 'c1') => [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: id, toolName: name, input: args }, { type: 'finish', finishReason: 'tool-calls', usage }];
export const B = {
  text, toolcall,
  inband: () => [{ type: 'stream-start', warnings: [] }, { type: 'error', error: { type: 'too_many_requests', code: 'rate_limit_exceeded', message: 'rate limited' } }, { type: 'finish', finishReason: 'error', usage }],
  empty: () => [{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: 'stop', usage }],
  throw: () => { throw new Error('503 Service Unavailable'); },
  hang: () => 'HANG',
};
// behaviors: array of functions (call index -> chunks); last repeats. counts in .calls
export function scriptedModel(id, behaviors) {
  const m = { calls: 0 };
  m.model = new MockLanguageModelV2({
    modelId: id,
    doGenerate: async () => {
      const i = m.calls++; const chunks = behaviors[Math.min(i, behaviors.length - 1)]();
      if (chunks === 'HANG') return new Promise(() => {});
      const t = chunks.filter(c => c.type === 'text-delta').map(c => c.delta).join('');
      return { content: t ? [{ type: 'text', text: t }] : [], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async ({ abortSignal }) => {
      const i = m.calls++;
      const b = behaviors[Math.min(i, behaviors.length - 1)];
      const chunks = b();
      if (chunks === 'HANG') {
        // stream that never produces anything and never closes; honours abort only if signal fires
        return { stream: new ReadableStream({ start(c) { abortSignal?.addEventListener('abort', () => { try { c.error(abortSignal.reason ?? new Error('aborted')); } catch {} }); } }) };
      }
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return m;
}
// run fn with hard guard (to detect hangs). returns {status, ms, value|error}
export async function guarded(fn, ms = 8000) {
  const s = Date.now(); let timer;
  const guard = new Promise(r => { timer = setTimeout(() => r({ status: 'HUNG_PAST_GUARD(' + ms + 'ms)' }), ms); });
  const run = fn().then(v => ({ status: 'ok', value: v }), e => ({ status: 'threw', error: String(e?.message ?? e).slice(0, 160) }));
  const r = await Promise.race([run, guard]); clearTimeout(timer);
  return { ...r, ms: Date.now() - s };
}
export const row = (o) => console.log(JSON.stringify(o));
