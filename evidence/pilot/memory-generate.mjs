// (1) agent.generate() under in-band error / thrown 503 (single & fallback); (2) memory state after failed runs (template uses new Memory()).
import './stubs.mjs';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { B, scriptedModel, guarded, row } from './lib.mjs';
const ok = [() => B.text('FALLBACK OK')];
for (const [name, beh] of [['thrown503', [B.throw]], ['empty', [B.empty]]]) for (const fallback of [false, true]) {
  const p = scriptedModel('p', beh), fb = scriptedModel('fb', ok);
  const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model: fallback ? [{ model: p.model, maxRetries: 0 }, { model: fb.model, maxRetries: 0 }] : p.model });
  const r = await guarded(async () => { const o = await agent.generate('hi'); return { text: o.text, finish: o.finishReason, err: o.error ? String(o.error.message ?? o.error).slice(0, 60) : null }; });
  row({ scenario: `generate(): ${name}`, fallbackCfg: fallback, primaryCalls: p.calls, fallbackCalls: fb.calls, ...r });
}
// memory persistence after failure
for (const [name, beh, abort] of [['control ok', [() => B.text('hello')]], ['in-band error', [B.inband]], ['thrown 503', [B.throw]], ['abort mid-hang', [B.hang], 800]]) {
  const p = scriptedModel('p', beh);
  const memory = new Memory();
  const agent = new Agent({ id: 'mem-agent', name: 'a', instructions: 'x', model: p.model, memory });
  const m = new Mastra({ storage: new InMemoryStore(), agents: { agent }, logger: false });
  const a = m.getAgent('agent');
  const r = await guarded(async () => { const out = await a.stream('my name is Zed', { memory: { thread: 't1', resource: 'u1' }, abortSignal: abort ? AbortSignal.timeout(abort) : undefined }); await out.text; return 'done'; }, 4000); if (r.error) console.log('  err:', r.error);
  await new Promise(r => setTimeout(r, 200));
  const { messages } = await memory.recall({ threadId: 't1', resourceId: 'u1' });
  row({ scenario: `memory after: ${name}`, runStatus: r.status, persisted: messages.map(x => x.role + ':' + JSON.stringify(x.content?.parts?.[0]?.text ?? '').slice(0, 20)) });
}
process.exit(0);
