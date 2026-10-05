// Isolated repro: experiments with concurrent items on a LibSQL file store.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { dataset, mockAgent, qualityScorer } from '../test/helpers.js';

const results: Record<string, unknown> = {};
for (const [concurrency, busyTimeout] of [[5, undefined], [5, 30000], [10, 30000]] as const) {
  let ok = 0, busy = 0, other = 0, snapshot = 0;
  for (let trial = 0; trial < 5; trial++) {
    const url = `file:${join(mkdtempSync(join(tmpdir(), 'busy-')), 'm.db')}`;
    const mastra = new Mastra({ storage: new LibSQLStore({ id: 'busy', url, ...(busyTimeout ? { connectionTimeoutMs: busyTimeout } : {}) }), agents: { a: mockAgent('a', undefined, () => 0.9) }, logger: false });
    const ds = await dataset(mastra, 20);
    try {
      await ds.startExperiment({ targetType: 'agent', targetId: 'a', scorers: [qualityScorer()], maxConcurrency: concurrency });
      ok++;
    } catch (e) {
      let text = '';
      for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause) text += ` ${String(x)} ${(x as { code?: string }).code ?? ''} ${(x as { extendedCode?: string }).extendedCode ?? ''}`;
      if (trial === 0 && concurrency === 5) console.error('ERR', text.slice(0, 400));
      if (text.includes('SNAPSHOT')) snapshot++;
      text.includes('SQLITE_BUSY') ? busy++ : other++;
    }
  }
  results[`maxConcurrency ${concurrency}, connectionTimeoutMs ${busyTimeout ?? 'default 5000'}`] = { ok, busy, snapshot, other };
}
console.log(JSON.stringify(results));
process.exit(0);
