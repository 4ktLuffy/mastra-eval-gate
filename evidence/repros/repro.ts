import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const a = createStep({ id: 'a', inputSchema: z.object({}), outputSchema: z.object({ n: z.number() }), execute: async () => ({ n: 1 }) });
const needsString = createStep({ id: 'b', inputSchema: z.object({ s: z.string() }), outputSchema: z.object({ ok: z.boolean() }), execute: async ({ inputData }) => ({ ok: inputData.s.length > 0 }) });

// Control: direct .then with mismatched schemas SHOULD error
createWorkflow({ id: 'ctl', inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) })
  .then(a)
  .then(needsString) // EXPECT error
  .commit();

// Issue: .map returns the wrong shape ({ wrong: number } instead of { s: string }); does tsc complain?
createWorkflow({ id: 'wf', inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) })
  .then(a)
  .map(async ({ inputData }) => ({ wrong: inputData.n }))
  .then(needsString) // issue claims NO error
  .commit();
