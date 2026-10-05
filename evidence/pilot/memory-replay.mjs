// After a failed run, what does the NEXT turn send to the model? (empty assistant message persisted in thread?)
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { scriptedModel } from './lib.mjs';
import { B, usage, row } from './lib.mjs';
for (const [fault, f] of [['control ok', () => B.text('hello')], ['in-band error', B.inband], ['thrown 503', B.throw]]) {
  let n = 0, prompts = [];
  const model = new MockLanguageModelV2({ doStream: async ({ prompt }) => { n++; if (n === 1) { const c = f(); return { stream: simulateReadableStream({ chunks: c }) }; } prompts.push(prompt); return { stream: simulateReadableStream({ chunks: B.text('ok') }) }; } });
  const agent = new Agent({ id: 'agent', name: 'a', instructions: 'x', model, memory: new Memory() });
  const m = new Mastra({ storage: new InMemoryStore(), agents: { agent }, logger: false });
  const a = m.getAgent('agent'); const mem = { thread: 't', resource: 'u' };
  try { const o = await a.stream('first question', { memory: mem }); await o.text; } catch {}
  const o2 = await a.stream('second question', { memory: mem }); await o2.text;
  row({ fault, nextTurnPrompt: prompts[0].map(p => p.role + ':' + (Array.isArray(p.content) ? p.content.map(c => c.text ?? c.type).join('|') : String(p.content)).slice(0, 40)) });
}
// generate() path, same question as #19887
{
  const memory = new Memory();
  const agent = new Agent({ id: 'agent', name: 'a', instructions: 'x', model: scriptedModel('p', [B.throw]).model, memory });
  const m = new Mastra({ storage: new InMemoryStore(), agents: { agent }, logger: false });
  let err; try { await m.getAgent('agent').generate('my name is Zed', { memory: { thread: 't', resource: 'u' } }); } catch (e) { err = e.message; }
  const { messages } = await memory.recall({ threadId: 't', resourceId: 'u' });
  row({ scenario: 'generate() thrown 503 + memory (#19887 path)', err, persisted: messages.map(x => x.role + ':' + JSON.stringify(x.content?.parts?.[0]?.text ?? '')) });
}
process.exit(0);
