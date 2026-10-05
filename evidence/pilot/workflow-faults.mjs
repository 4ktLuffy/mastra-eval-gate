// Workflow-fault scenarios. Shape modelled on customer-refund-agent (resolve-support-case: classify -> issue refund
// (side effect, idempotencyKey) -> approval suspend -> finalize) and kyc durable onboarding (parallel checks, dowhile+suspend).
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { sleep, row, guarded } from './lib.mjs';

const mkMastra = (wfs, storage = new InMemoryStore()) => new Mastra({ storage, workflows: wfs, logger: false });
const io = z.object({ n: z.number() });
const summarize = (res) => ({ status: res.status, error: res.error ? String(res.error.message ?? res.error).slice(0, 80) : undefined,
  steps: Object.fromEntries(Object.entries(res.steps ?? {}).map(([k, v]) => [k, v.status + (v.error ? `(${String(v.error.message ?? v.error).slice(0, 40)})` : '')])) });

// ---------- A. retries on a side-effecting step ----------
async function retriesScenario(name, { failFirst, throwAfterEffect, retries, idem }) {
  const effects = []; const provider = new Set(); let runs = 0;
  const refund = createStep({ id: 'issue-refund', inputSchema: io, outputSchema: io, retries,
    execute: async ({ inputData }) => {
      runs++;
      const key = 'case-1';
      if (idem && provider.has(key)) { return { n: inputData.n }; }   // provider-side idempotency
      if (!throwAfterEffect && runs <= failFirst) throw new Error('transport error before effect');
      effects.push('refund$' + inputData.n); provider.add(key);        // the side effect
      if (throwAfterEffect && runs <= failFirst) throw new Error('timeout AFTER effect committed');
      return { n: inputData.n };
    } });
  const wf = createWorkflow({ id: 'wf', inputSchema: io, outputSchema: io }).then(refund).commit();
  const m = mkMastra({ wf }); const run = await m.getWorkflow('wf').createRun();
  const t = Date.now(); const res = await run.start({ inputData: { n: 10 } });
  row({ scenario: name, stepRuns: runs, sideEffects: effects.length, ms: Date.now() - t, ...summarize(res) });
}
await retriesScenario('retries_control_no_fault (retries:2)', { failFirst: 0, retries: 2 });
await retriesScenario('step_always_throws retries:2', { failFirst: 99, retries: 2 });
await retriesScenario('step_always_throws retries:0', { failFirst: 99, retries: 0 });
await retriesScenario('step_always_throws retries unset', { failFirst: 99 });
await retriesScenario('throw_after_effect once, retries:2, NO idempotency', { failFirst: 1, throwAfterEffect: true, retries: 2 });
await retriesScenario('throw_after_effect once, retries:2, WITH idempotency', { failFirst: 1, throwAfterEffect: true, retries: 2, idem: true });

// ---------- B. suspend / resume (approval step) ----------
async function suspendScenario(name, { restart }) {
  const counts = { classify: 0, preSuspendEffect: 0, refund: 0 };
  const classify = createStep({ id: 'classify', inputSchema: io, outputSchema: io, execute: async ({ inputData }) => { counts.classify++; return inputData; } });
  const approve = createStep({ id: 'request-approval', inputSchema: io, outputSchema: io,
    suspendSchema: z.object({ reason: z.string() }), resumeSchema: z.object({ approved: z.boolean() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      counts.preSuspendEffect++;                        // e.g. "send approval email" placed before suspend()
      if (!resumeData) return await suspend({ reason: 'needs human' });
      if (!resumeData.approved) throw new Error('rejected');
      return inputData;
    } });
  const refund = createStep({ id: 'refund', inputSchema: io, outputSchema: io, execute: async ({ inputData }) => { counts.refund++; return inputData; } });
  const mk = () => createWorkflow({ id: 'wf', inputSchema: io, outputSchema: io }).then(classify).then(approve).then(refund).commit();
  const storage = new InMemoryStore();
  let m = mkMastra({ wf: mk() }, storage);
  const run = await m.getWorkflow('wf').createRun();
  const r1 = await run.start({ inputData: { n: 1 } });
  let run2 = run;
  if (restart) { m = mkMastra({ wf: mk() }, storage); run2 = await m.getWorkflow('wf').createRun({ runId: run.runId }); }
  const r2 = await run2.resume({ step: 'request-approval', resumeData: { approved: true } });
  row({ scenario: name, afterStart: r1.status, suspended: JSON.stringify(r1.suspended), counts, afterResume: r2.status, ...(r2.status !== 'success' ? summarize(r2) : {}) });
}
await suspendScenario('suspend_resume same Mastra instance', { restart: false });
await suspendScenario('suspend_resume after "restart" (new Mastra, shared storage)', { restart: true });

// ---------- C. parallel with one branch failing ----------
async function parallelScenario(name, { failBranch, retries }) {
  const done = {}; const starts = {};
  const mk = (id, ms) => createStep({ id, inputSchema: io, outputSchema: io, retries, execute: async ({ inputData }) => {
    starts[id] = (starts[id] ?? 0) + 1;
    await sleep(ms); if (id === failBranch) throw new Error(id + ' failed'); done[id] = true; return inputData; } });
  const wf = createWorkflow({ id: 'wf', inputSchema: io, outputSchema: z.any() }).parallel([mk('identity', 50), mk('address', 50), mk('sanctions', 500), mk('pep', 50)]).commit();
  const m = mkMastra({ wf }); const run = await m.getWorkflow('wf').createRun();
  const t = Date.now(); const res = await run.start({ inputData: { n: 1 } });
  row({ scenario: name, branchStarts: starts, branchCompleted: Object.keys(done), ms: Date.now() - t, ...summarize(res) });
}
await parallelScenario('parallel_control_all_ok', { failBranch: null });
await parallelScenario('parallel_one_branch_fails (fast branch "pep")', { failBranch: 'pep' });
await parallelScenario('parallel_one_branch_fails + retries:1', { failBranch: 'pep', retries: 1 });

// ---------- D. nested workflow retry multiplication ----------
{
  let runs = 0;
  const inner = createStep({ id: 'inner', inputSchema: io, outputSchema: io, retries: 2, execute: async () => { runs++; throw new Error('inner fails'); } });
  const nested = createWorkflow({ id: 'nested', inputSchema: io, outputSchema: io }).then(inner).commit();
  const wf = createWorkflow({ id: 'wf', inputSchema: io, outputSchema: io }).then(nested).commit();
  const m = mkMastra({ wf }); const run = await m.getWorkflow('wf').createRun();
  const res = await run.start({ inputData: { n: 1 } });
  row({ scenario: 'nested_workflow inner step retries:2 (parent has no retries)', innerRuns: runs, ...summarize(res) });
}
// ---------- E. hung step: any default timeout? ----------
{
  const hang = createStep({ id: 'hang', inputSchema: io, outputSchema: io, execute: async () => new Promise(() => {}) });
  const wf = createWorkflow({ id: 'wf', inputSchema: io, outputSchema: io }).then(hang).commit();
  const m = mkMastra({ wf }); const run = await m.getWorkflow('wf').createRun();
  const r = await guarded(() => run.start({ inputData: { n: 1 } }), 5000);
  row({ scenario: 'step_hangs_no_timeout_option', ...r });
}
// ---------- F. dowhile + suspend (KYC missing-information loop) ----------
{
  let execs = 0;
  const collect = createStep({ id: 'collect', inputSchema: io, outputSchema: io, suspendSchema: z.object({ ask: z.string() }), resumeSchema: z.object({ n: z.number() }),
    execute: async ({ inputData, resumeData, suspend }) => { execs++; if (!resumeData) return await suspend({ ask: 'more info' }); return { n: resumeData.n }; } });
  const wf = createWorkflow({ id: 'wf', inputSchema: io, outputSchema: io }).dowhile(collect, async ({ inputData }) => inputData.n < 3).commit();
  const m = mkMastra({ wf }); const run = await m.getWorkflow('wf').createRun();
  const trace = [];
  let r = await run.start({ inputData: { n: 0 } }); trace.push(r.status);
  for (const n of [1, 3]) { if (r.status !== 'suspended') break; r = await run.resume({ step: 'collect', resumeData: { n } }); trace.push(r.status); }
  row({ scenario: 'dowhile+suspend (kyc loop): resume with n=1 then n=3', trace, execs, ...(r.status === 'success' ? { result: r.result } : summarize(r)) });
}
process.exit(0);
