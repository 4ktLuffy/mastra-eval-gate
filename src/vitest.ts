/**
 * Vitest helpers, in the style of `@mastra/evals/vitest`:
 *
 *   test('candidate is not worse than the baseline', async () => {
 *     await expectGate(mastra, { baseline, candidate, thresholds: { accuracy: { value: 0.05 } } }).toPass();
 *   });
 *
 * or, after `registerGateMatchers()` (e.g. in a setup file):
 *
 *   expect(await gate(mastra, { baseline, candidate })).toPassEvalGate();
 */
import type { Mastra } from '@mastra/core';
import { expect } from 'vitest';
import type { CompareOptions, Comparison } from './compare.js';
import { gate } from './index.js';
import { formatReport } from './report.js';

/** Thrown by `expectGate(...).toPass()` when the gate fails; carries the full comparison. */
export class GateFailedError extends Error {
  constructor(readonly comparison: Comparison) {
    super(`Eval gate failed:\n${formatReport(comparison)}`);
    this.name = 'GateFailedError';
  }
}

export function expectGate(
  mastra: Mastra,
  options: { baseline: string; candidate: string } & CompareOptions,
): { toPass(): Promise<Comparison> } {
  return {
    async toPass() {
      const comparison = await gate(mastra, options);
      if (!comparison.passed) throw new GateFailedError(comparison);
      return comparison;
    },
  };
}

const isComparison = (x: unknown): x is Comparison =>
  typeof x === 'object' && x !== null && 'passed' in x && 'reasons' in x && 'reliability' in x;

export const gateMatchers = {
  toPassEvalGate(received: unknown) {
    if (!isComparison(received)) {
      return { pass: false, message: () => 'expected the result of gate() / compareRows()' };
    }
    return {
      pass: received.passed,
      message: () =>
        received.passed ? `expected the eval gate to fail, but it passed:\n${formatReport(received)}` : `Eval gate failed:\n${formatReport(received)}`,
    };
  },
};

/** Adds `toPassEvalGate()` to Vitest's `expect`. */
export function registerGateMatchers(): void {
  expect.extend(gateMatchers);
}

declare module 'vitest' {
  interface Assertion<T = any> {
    toPassEvalGate(): T;
  }
  interface AsymmetricMatchersContaining {
    toPassEvalGate(): unknown;
  }
}
