import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { createToxicityScorer, createBiasScorer, createHallucinationScorer, createFaithfulnessScorer, createAnswerRelevancyScorer } from '@mastra/evals/scorers/prebuilt';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
// Judge: call 1 = preprocess (non-empty claims/opinions/statements), analyze = EMPTY array, reason = text. Dispatches on the requested schema keys.
function judge(preprocessJson, analyzeJson) {
  let call = 0; const log = [];
  const pick = (prompt) => {
    call++;
    const sys = JSON.stringify(prompt).toLowerCase();
    return call === 1 && preprocessJson ? preprocessJson : (call === 1 || (call === 2 && preprocessJson)) ? analyzeJson : JSON.stringify({ reason: 'r' });
  };
  const m = new MockLanguageModelV2({
    modelId: 'judge',
    doGenerate: async ({ prompt }) => { const t = pick(prompt); log.push(t); return { content: [{ type: 'text', text: t }], finishReason: 'stop', usage, warnings: [] }; },
    doStream: async ({ prompt }) => { const t = pick(prompt); log.push(t); return { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: t }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }] }) }; },
  });
  return { m, log };
}
const run = { input: { inputMessages: [{ id: 'u', role: 'user', content: 'tell me about X', parts: [{ type: 'text', text: 'tell me about X' }] }] },
  output: [{ id: 'a', role: 'assistant', content: 'You idiot. Women are bad drivers. The moon is cheese.', parts: [{ type: 'text', text: 'You idiot. Women are bad drivers. The moon is cheese.' }] }] };
const cases = [
  ['toxicity', m => createToxicityScorer({ model: m }), null, '{"verdicts":[]}'],
  ['toxicity scale=100', m => createToxicityScorer({ model: m, options: { scale: 100 } }), null, '{"verdicts":[]}'],
  ['bias', m => createBiasScorer({ model: m }), '{"opinions":["Women are bad drivers","You idiot"]}', '{"results":[]}'],
  ['hallucination', m => createHallucinationScorer({ model: m, options: { context: ['The moon is rock'] } }), '{"claims":["The moon is cheese","X"]}', '{"verdicts":[]}'],
  ['faithfulness', m => createFaithfulnessScorer({ model: m, options: { context: ['The moon is rock'] } }), '{"claims":["The moon is cheese","X"]}', '{"verdicts":[]}'],
  ['answer-relevancy', m => createAnswerRelevancyScorer({ model: m }), '{"statements":["The moon is cheese","X"]}', '{"results":[]}'],
];
for (const [name, mk, pre, an] of cases) {
  const { m, log } = judge(pre, an);
  try {
    const r = await mk(m).run(run);
    console.log(JSON.stringify({ scorer: name, score: r.score, notScorable: r.notScorable ?? null, error: r.error ?? null, preprocessStepResult: r.preprocessStepResult ?? null, analyzeStepResult: r.analyzeStepResult ?? null }));
  } catch (e) { console.log(JSON.stringify({ scorer: name, THREW: String(e.message).slice(0, 200), judgeCalls: log.length })); }
}
// NEG CONTROL: well-formed non-empty verdicts
const ctl = [['toxicity', m => createToxicityScorer({ model: m }), null, '{"verdicts":[{"verdict":"yes","reason":"r"},{"verdict":"no","reason":"r"}]}'],
 ['faithfulness', m => createFaithfulnessScorer({ model: m, options: { context: ['c'] } }), '{"claims":["a","b"]}', '{"verdicts":[{"verdict":"yes","reason":"r"},{"verdict":"no","reason":"r"}]}']];
for (const [name, mk, pre, an] of ctl) { const { m } = judge(pre, an); const r = await mk(m).run(run); console.log(JSON.stringify({ NEG_CONTROL: name, score: r.score })); }
process.exit(0);
