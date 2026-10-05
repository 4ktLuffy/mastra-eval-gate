// Tool-fault scenarios: weather tool from template, fetch faked at the network edge.
import { fetchStats } from './stubs.mjs';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { weatherTool } from './tpl/weather-agent/src/mastra/tools/weather-tool.ts';
import { B, scriptedModel, guarded, row, T, sleep, usage } from './lib.mjs';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';

const run = async (name, mode, { abort, delayMs = 0, guard = 7000 } = {}) => {
  Object.assign(fetchStats, { geo: 0, weather: 0, mode, delayMs });
  const m = scriptedModel('p', [() => B.toolcall('weatherTool', '{"location":"Paris"}'), () => B.text('final answer')]);
  const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model: m.model, tools: { weatherTool } });
  const seen = [];
  const r = await guarded(async () => {
    const out = await agent.stream('weather?', { maxSteps: 4, abortSignal: abort ? AbortSignal.timeout(abort) : undefined });
    for await (const c of out.fullStream) if (c.type === 'tool-error' || c.type === 'tool-result' || c.type === 'error') seen.push(c.type + ':' + JSON.stringify(c.payload?.error?.message ?? c.payload?.result ?? c.payload?.error ?? '').slice(0, 110));
    return { text: await out.text, finish: await out.finishReason };
  }, guard);
  row({ scenario: name, modelCalls: m.calls, geoFetch: fetchStats.geo, weatherFetch: fetchStats.weather, chunks: seen, ...r });
};
await run('control_tool_ok', 'ok');
await run('tool_throws (ECONNRESET)', 'throw');
await run('tool_hangs_no_timeout', 'hang');
await run('tool_hangs_abort2s', 'hang', { abort: 2000 });
await run('tool_output_schema_invalid', 'badshape');

// slow(3s)+fast alongside, with call counting; stream timing of tool-results (re-confirm #21902)
const t0 = Date.now(); const ts = {};
const mk = (id, ms) => createTool({ id, description: id, inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => { await sleep(ms); ts[id + '_finished'] = Date.now() - t0; return { ok: true }; } });
const m2 = scriptedModel('p', [() => [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'A', toolName: 'fast', input: '{}' }, { type: 'tool-call', toolCallId: 'B', toolName: 'slow', input: '{}' }, { type: 'finish', finishReason: 'tool-calls', usage }], () => B.text('done')]);
const ag = new Agent({ id: 'a', name: 'a', instructions: 'x', model: m2.model, tools: { fast: mk('fast', 300), slow: mk('slow', 3000) } });
const out = await ag.stream('go');
for await (const c of out.fullStream) if (c.type === 'tool-result') ts['streamed_' + c.payload.toolName] = Date.now() - t0;
row({ scenario: 'slow3s_alongside_fast', modelCalls: m2.calls, ...ts });
process.exit(0);
