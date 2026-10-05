import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV2, simulateReadableStream } from 'ai/test';
import { z } from 'zod';

const t0 = Date.now(); const T = () => Date.now() - t0;
const mk = (id, ms) => createTool({ id, description: id, inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => { await new Promise(r => setTimeout(r, ms)); console.log(`${String(T()).padStart(5)}ms  tool ${id} FINISHED executing`); return { ok: true }; } });
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let n = 0;
const model = new MockLanguageModelV2({ doStream: async () => { n++; return { stream: simulateReadableStream({ chunks: n === 1 ? [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'A', toolName: 'fast', input: '{}' },
  { type: 'tool-call', toolCallId: 'B', toolName: 'slow', input: '{}' },
  { type: 'finish', finishReason: 'tool-calls', usage } ] : [
  { type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'done' }, { type: 'text-end', id: '1' },
  { type: 'finish', finishReason: 'stop', usage } ] }) }; } });
const agent = new Agent({ id: 'a', name: 'a', instructions: 'x', model, tools: { fast: mk('fast', 300), slow: mk('slow', 3000) } });
const out = await agent.stream('go');
for await (const c of out.fullStream) if (c.type === 'tool-result') console.log(`${String(T()).padStart(5)}ms  stream tool-result for ${c.payload.toolName}`);
