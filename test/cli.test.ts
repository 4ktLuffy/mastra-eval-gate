/**
 * End-to-end: experiments written to a LibSQL file by one process, gated by the CLI in another.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { describe, expect, it } from 'vitest';
import { dataset, mockAgent, qualityScorer } from './helpers.js';

const cli = join(__dirname, '..', 'dist', 'cli.js');

function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('node', [cli, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

describe('CLI', () => {
  it('exits 1 with the reliability reason for a crashing candidate, 0 for an identical one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const url = `file:${join(dir, 'mastra.db')}`;
    const hardIsLow = (n: number) => (n >= 8 ? 0.3 : 0.9);
    const mastra = new Mastra({
      storage: new LibSQLStore({ id: 'gate-test', url }),
      agents: {
        base: mockAgent('base', undefined, hardIsLow),
        same: mockAgent('same', undefined, hardIsLow),
        crashy: mockAgent('crashy', n => (n >= 8 ? 'throw' : 'ok'), hardIsLow),
      },
      logger: false,
    });
    const ds = await dataset(mastra);
    const A = await ds.startExperiment({ targetType: 'agent', targetId: 'base', scorers: [qualityScorer()], maxConcurrency: 1 });
    const S = await ds.startExperiment({ targetType: 'agent', targetId: 'same', scorers: [qualityScorer()], maxConcurrency: 1 });
    const B = await ds.startExperiment({ targetType: 'agent', targetId: 'crashy', scorers: [qualityScorer()], maxConcurrency: 1 });

    // A user's mastra module, placed inside this project so it resolves @mastra/* from node_modules.
    const local = join(__dirname, `.cli-fixture-${process.pid}.mjs`);
    writeFileSync(
      local,
      `import { Mastra } from '@mastra/core';\nimport { LibSQLStore } from '@mastra/libsql';\n` +
        `export const mastra = new Mastra({ storage: new LibSQLStore({ id: 'gate-test', url: ${JSON.stringify(url)} }), logger: false });\n`,
    );

    const fail = run(['--mastra', local, '--baseline', A.experimentId, '--candidate', B.experimentId]);
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('FAIL');
    expect(fail.out).toContain('3 item(s) fail in the candidate');

    const pass = run(['--mastra', local, '--baseline', A.experimentId, '--candidate', S.experimentId]);
    expect(pass.code).toBe(0);
    expect(pass.out).toContain('PASS');

    // A malformed threshold is a usage error, not a silently disabled check.
    const typo = run(['--mastra', local, '--baseline', A.experimentId, '--candidate', B.experimentId, '--threshold', 'quality=..']);
    expect(typo.code).toBe(2);
    expect(typo.out).toContain('bad --threshold');
    // An expected scorer that never ran: insufficient evidence, exit 3.
    const missing = run(['--mastra', local, '--baseline', A.experimentId, '--candidate', S.experimentId, '--expect', 'faithfulness']);
    expect(missing.code).toBe(3);
    expect(missing.out).toContain('INSUFFICIENT EVIDENCE');

    // --storage reads the same experiments without loading any app module.
    const storageOnly = run(['--storage', url, '--baseline', A.experimentId, '--candidate', B.experimentId]);
    expect(storageOnly.code).toBe(1);
    expect(storageOnly.out).toContain('3 item(s) fail in the candidate');
    expect(run(['--storage', url, '--baseline', A.experimentId, '--candidate', S.experimentId]).code).toBe(0);

    const json = JSON.parse(run(['--mastra', local, '--baseline', A.experimentId, '--candidate', B.experimentId, '--json']).out);
    expect(json.reliability.newFailures).toBe(3);
    rmSync(local);

    // The same module as TypeScript, loaded by the CLI itself (no tsx wrapper).
    const ts = join(__dirname, `.cli-fixture-${process.pid}.ts`);
    writeFileSync(
      ts,
      `import { Mastra } from '@mastra/core';\nimport { LibSQLStore } from '@mastra/libsql';\n` +
        `const url: string = ${JSON.stringify(url)};\n` +
        `export const mastra: Mastra = new Mastra({ storage: new LibSQLStore({ id: 'gate-test', url }), logger: false });\n`,
    );
    const fromTs = run(['--mastra', ts, '--baseline', A.experimentId, '--candidate', B.experimentId]);
    rmSync(ts);
    expect(fromTs.code).toBe(1);
    expect(fromTs.out).toContain('3 item(s) fail in the candidate');
  });
});
