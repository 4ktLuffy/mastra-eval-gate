import type { Mastra } from '@mastra/core';
import { compareRows, type CompareOptions, type Comparison } from './compare.js';
import { loadExperimentRows } from './load.js';

export * from './compare.js';
export * from './stats.js';
export { loadExperimentRows } from './load.js';
export { formatReport } from './report.js';

/** Compare a baseline and a candidate experiment stored in `mastra`. */
export async function gate(
  mastra: Mastra,
  { baseline, candidate, ...options }: { baseline: string; candidate: string } & CompareOptions,
): Promise<Comparison> {
  const [a, b] = await Promise.all([loadExperimentRows(mastra, baseline), loadExperimentRows(mastra, candidate)]);
  return compareRows(a, b, options);
}
