#!/usr/bin/env node
/**
 * mastra-eval-gate --mastra <module> --baseline <experimentId> --candidate <experimentId>
 *   [--threshold scorer=0.05[:lower]] [--expect scorer] [--alpha 0.05] [--reliability strict|statistical]
 *   [--max-new-failures 0] [--max-coverage-loss 0] [--allow-subset] [--mid-p] [--json]
 *
 * <module> must export a configured `mastra` instance (default export or named `mastra`). A
 * TypeScript module (.ts/.mts/.cts/.tsx), such as a Mastra project's src/mastra/index.ts, is
 * loaded through tsx, so no build step or wrapper is needed.
 * Exit code: 0 pass, 1 fail, 2 usage or load error, 3 insufficient evidence.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Mastra } from '@mastra/core';
import type { ScorerThreshold } from './compare.js';
import { gate } from './index.js';
import { formatReport } from './report.js';

/** Import a JS module directly, or a TypeScript one through tsx's loader. */
async function loadModule(path: string): Promise<unknown> {
  const url = pathToFileURL(resolve(path)).href;
  if (/\.[cm]?tsx?$/.test(path)) {
    const { tsImport } = await import('tsx/esm/api');
    return tsImport(url, import.meta.url);
  }
  return import(url);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mastra: { type: 'string' },
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      threshold: { type: 'string', multiple: true },
      expect: { type: 'string', multiple: true },
      reliability: { type: 'string' },
      'allow-subset': { type: 'boolean' },
      alpha: { type: 'string' },
      'max-new-failures': { type: 'string' },
      'max-coverage-loss': { type: 'string' },
      'mid-p': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.mastra || !values.baseline || !values.candidate) {
    console.error(
      'usage: mastra-eval-gate --mastra <module> --baseline <id> --candidate <id> [--threshold scorer=0.05[:lower]] [--expect scorer] [--reliability strict|statistical] [--json]',
    );
    return 2;
  }

  const mod = (await loadModule(values.mastra)) as { mastra?: Mastra; default?: Mastra };
  const mastra = mod.mastra ?? mod.default;
  if (!mastra || typeof (mastra as Mastra).getStorage !== 'function') {
    console.error(`${values.mastra} does not export a Mastra instance (as default or "mastra").`);
    return 2;
  }

  const thresholds: Record<string, ScorerThreshold> = {};
  for (const t of values.threshold ?? []) {
    const m = t.match(/^([^=]+)=(\d+(?:\.\d+)?|\.\d+)(?::(lower|higher))?$/);
    if (!m) {
      console.error(`bad --threshold "${t}" (expected scorer=0.05 or scorer=0.05:lower)`);
      return 2;
    }
    thresholds[m[1]!] = { value: Number(m[2]), direction: m[3] === 'lower' ? 'lower-is-better' : 'higher-is-better' };
  }
  const num = (name: string, x: string | undefined) => {
    if (x === undefined) return undefined;
    const n = Number(x);
    if (x.trim() === '' || !Number.isFinite(n)) throw new TypeError(`--${name} must be a number (got "${x}")`);
    return n;
  };

  let result;
  try {
    result = await gate(mastra, {
      baseline: values.baseline,
      candidate: values.candidate,
      thresholds,
      expectedScorers: values.expect,
      reliability: values.reliability as 'strict' | 'statistical' | undefined,
      alpha: num('alpha', values.alpha),
      maxNewTargetFailures: num('max-new-failures', values['max-new-failures']),
      maxCoverageLoss: num('max-coverage-loss', values['max-coverage-loss']),
      allowSubset: values['allow-subset'],
      midP: values['mid-p'],
    });
  } catch (e) {
    if (e instanceof TypeError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
  console.log(values.json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.verdict === 'pass' ? 0 : result.verdict === 'fail' ? 1 : 3;
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
