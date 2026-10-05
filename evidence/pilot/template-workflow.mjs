// VERBATIM weather-workflow.ts from templates/weather-agent; model mocked, open-meteo faked.
import { fetchStats } from './stubs.mjs';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { weatherWorkflow } from './tpl/weather-agent/src/mastra/workflows/weather-workflow.ts';
import { weatherTool } from './tpl/weather-agent/src/mastra/tools/weather-tool.ts';
import { B, scriptedModel, row, guarded } from './lib.mjs';
const plan = (label, beh, { fallback, guard = 6000 } = {}) => async () => {
  Object.assign(fetchStats, { geo: 0, weather: 0, mode: 'ok' });
  const p = scriptedModel('primary', beh), fb = scriptedModel('fallback', [() => B.text('FALLBACK PLAN: museums')]);
  const model = fallback ? [{ model: p.model, maxRetries: 0 }, { model: fb.model, maxRetries: 0 }] : p.model;
  const weatherAgent = new Agent({ id: 'weather-agent', name: 'Weather Agent', instructions: 'x', model, tools: { weatherTool } });
  const m = new Mastra({ storage: new InMemoryStore(), agents: { weatherAgent }, workflows: { weatherWorkflow }, logger: false });
  const run = await m.getWorkflow('weatherWorkflow').createRun();
  const r = await guarded(async () => { const res = await run.start({ inputData: { city: 'Paris' } }); return { status: res.status, activities: res.result?.activities?.slice(0, 40), err: res.error?.message?.slice(0, 60) }; }, guard);
  process.stdout.write('\n');
  row({ scenario: label, primaryCalls: p.calls, fallbackCalls: fb.calls, ...r });
};
await plan('wf_control: model ok', [() => B.text('Visit the Louvre')])();
await plan('wf_planActivities: in-band rate-limit error, single model', [B.inband])();
await plan('wf_planActivities: in-band rate-limit error, WITH fallback', [B.inband], { fallback: true })();
await plan('wf_planActivities: thrown 503, single model', [B.throw])();
await plan('wf_planActivities: thrown 503, WITH fallback', [B.throw], { fallback: true })();
await plan('wf_planActivities: empty response', [B.empty])();
process.exit(0);
