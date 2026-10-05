// Latency pilot: 3 problems at effort none vs medium. npx tsx bench/real-pilot.ts
import { Agent } from '@mastra/core/agent';
import { codexModel, SECONDS, TOKENS } from './codex-model.js';
import { lastInteger, problems } from './real-dataset.js';

const ps = problems(30).filter(p => ['p03', 'p05', 'p10'].includes(p.id));
for (const effort of ['none', 'medium'] as const) {
  const agent = new Agent({ id: effort, name: effort, instructions: 'Solve the problem. End your reply with the final number.', model: codexModel({ effort }) });
  for (const p of ps) {
    const t = Date.now();
    const r = await agent.generate(p.question);
    console.log(JSON.stringify({ effort, id: p.id, steps: p.steps, s: (Date.now() - t) / 1000, got: lastInteger(r.text), want: p.answer }));
  }
}
console.log(JSON.stringify({ calls: TOKENS.length, tokens: TOKENS.reduce((a, b) => a + b, 0), seconds: SECONDS }));
