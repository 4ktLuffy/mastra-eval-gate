// Configured-timeout variants: model hang with modelSettings.timeout, with/without fallback; tool hang with abort/totalMs.
import { fetchStats } from './stubs.mjs';
import { Agent } from '@mastra/core/agent';
import { weatherTool } from './tpl/weather-agent/src/mastra/tools/weather-tool.ts';
import { B, scriptedModel, guarded, row } from './lib.mjs';
const good = [() => B.toolcall('weatherTool', '{"location":"Paris"}'), () => B.text('It is 20C in Paris')];
async function go(name, { beh, fallback, timeout, abort, mode = 'ok', guard = 7000 }) {
  Object.assign(fetchStats, { geo: 0, weather: 0, mode });
  const p = scriptedModel('primary', beh), fb = scriptedModel('fallback', good);
  const model = fallback ? [{ model: p.model, maxRetries: 0 }, { model: fb.model, maxRetries: 0 }] : p.model;
  const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model, tools: { weatherTool } });
  const r = await guarded(async () => {
    const out = await agent.stream('weather?', { maxSteps: 4, modelSettings: timeout ? { timeout } : undefined, abortSignal: abort ? AbortSignal.timeout(abort) : undefined });
    for await (const c of out.fullStream) {}
    return { text: await out.text, finish: await out.finishReason, err: out.error ? String(out.error.message ?? out.error).slice(0, 90) : null };
  }, guard);
  row({ scenario: name, primaryCalls: p.calls, fallbackCalls: fb.calls, weatherFetch: fetchStats.weather, ...r });
}
await go('model_hang + stepMs:1500, single', { beh: [B.hang, ...good], timeout: { stepMs: 1500 } });
await go('model_hang + stepMs:1500, WITH fallback', { beh: [B.hang, ...good], timeout: { stepMs: 1500 }, fallback: true });
await go('model_hang + firstChunkMs:1500, WITH fallback', { beh: [B.hang, ...good], timeout: { firstChunkMs: 1500 }, fallback: true });
await go('model_hang + totalMs:1500, WITH fallback', { beh: [B.hang, ...good], timeout: { totalMs: 1500 }, fallback: true });
await go('tool_hang + totalMs:1500', { beh: good, mode: 'hang', timeout: { totalMs: 1500 } });
await go('tool_hang + stepMs:1500', { beh: good, mode: 'hang', timeout: { stepMs: 1500 } });
await go('tool_hang + abortSignal 1500 (re-run)', { beh: good, mode: 'hang', abort: 1500 });
process.exit(0);
