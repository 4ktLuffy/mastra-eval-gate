// Which consumption paths surface a model failure? (no memory, no Mastra instance; thrown 503 and in-band error)
import { Agent } from '@mastra/core/agent';
import { B, scriptedModel, row, guarded } from './lib.mjs';
const paths = {
  'await out.text': async o => ({ v: await o.text }),
  'for await textStream': async o => { let s = ''; for await (const c of o.textStream) s += c; return { v: s }; },
  'for await fullStream': async o => { const t = []; for await (const c of o.fullStream) t.push(c.type); return { v: t.join(',') }; },
  'await out.getFullOutput()': async o => { const f = await o.getFullOutput(); return { v: f.text, finish: f.finishReason, error: f.error ? String(f.error.message ?? f.error) : null }; },
};
for (const [fname, beh] of [['in-band error', B.inband], ['thrown 503', B.throw]]) for (const [pname, fn] of Object.entries(paths)) {
  const p = scriptedModel('p', [beh]);
  const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model: p.model });
  const r = await guarded(async () => fn(await agent.stream('hi')), 4000);
  row({ fault: fname, consume: pname, ...r });
}
process.exit(0);
