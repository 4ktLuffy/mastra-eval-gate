// Model-fault scenarios against the weather-agent template (tool imported verbatim from templates).
import './stubs.mjs';
import { fetchStats } from './stubs.mjs';
import { Agent } from '@mastra/core/agent';
import { weatherTool } from './tpl/weather-agent/src/mastra/tools/weather-tool.ts';
import { B, scriptedModel, guarded, row } from './lib.mjs';
const INSTR = 'You are a helpful weather assistant ... Use the weatherTool to fetch current weather data.'; // abbreviated template instructions
const good = [() => B.toolcall('weatherTool', '{"location":"Paris"}'), () => B.text('It is 20C in Paris')];
const faults = {
  control_nofault: [...good],
  inband_rate_limit: [B.inband, ...good],
  thrown_503: [B.throw, ...good],
  hang_noTimeout: [B.hang, ...good],
  hang_withAbort2s: [B.hang, ...good],
  malformed_json_args: [() => B.toolcall('weatherTool', '{"location": "Par'), () => B.text('recovered')],
  schema_violating_args: [() => B.toolcall('weatherTool', '{"location": 123}'), () => B.text('recovered')],
  empty_response: [B.empty, ...good],
};
const mode = process.argv[2] ?? 'both';
for (const [name, beh] of Object.entries(faults)) {
  for (const withFallback of [false, true]) {
    if (mode === 'single' && withFallback) continue;
    fetchStats.geo = fetchStats.weather = 0;
    const primary = scriptedModel('primary', beh);
    const fb = scriptedModel('fallback', good);
    const model = withFallback ? [{ model: primary.model, maxRetries: 0 }, { model: fb.model, maxRetries: 0 }] : primary.model;
    const agent = new Agent({ id: 'weather-agent', name: 'Weather Agent', instructions: INSTR, model, tools: { weatherTool } });
    const abortSignal = name === 'hang_withAbort2s' ? AbortSignal.timeout(2000) : undefined;
    const errs = [];
    const r = await guarded(async () => {
      const out = await agent.stream('weather in Paris?', { abortSignal, maxSteps: 4, onError: (e) => errs.push(String(e?.error?.message ?? e?.message ?? JSON.stringify(e)).slice(0, 80)) });
      const chunkTypes = new Set(); const toolErrs = [];
      for await (const c of out.fullStream) { chunkTypes.add(c.type); if (c.type === 'tool-error') toolErrs.push(String(c.payload?.error?.message ?? c.payload?.error).slice(0, 100)); }
      return { text: (await out.text)?.slice(0, 60), finish: await out.finishReason, outError: out.error ? String(out.error.message ?? out.error).slice(0, 80) : null, toolErrs, hasErrorChunk: chunkTypes.has('error') };
    }, 7000);
    row({ scenario: name, fallbackCfg: withFallback, primaryCalls: primary.calls, fallbackCalls: fb.calls, weatherFetches: fetchStats.weather, onError: errs, ms: r.ms, ...r });
  }
}
process.exit(0);
