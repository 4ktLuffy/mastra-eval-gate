import type { Mastra } from '@mastra/core';
import { compareRows, type CompareOptions, type Comparison } from './compare.js';
import { loadExperimentRows } from './load.js';

export * from './compare.js';
export * from './stats.js';
export { loadExperimentRows } from './load.js';
export { formatReport } from './report.js';

/**
 * Compare a baseline and a candidate experiment stored in `mastra`. Each side can be one experiment
 * id or several runs of the same dataset (evidence is combined; see `test: 'betting'`).
 */
export async function gate(
  mastra: Mastra,
  { baseline, candidate, ...options }: { baseline: string | string[]; candidate: string | string[] } & CompareOptions,
): Promise<Comparison> {
  const ids = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
  const [a, b] = await Promise.all([
    Promise.all(ids(baseline).map(id => loadExperimentRows(mastra, id))),
    Promise.all(ids(candidate).map(id => loadExperimentRows(mastra, id))),
  ]);
  return compareRows(a, b, options);
}
