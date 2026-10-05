/**
 * Read an experiment's result and score rows from a Mastra instance's storage.
 */

import type { Mastra } from '@mastra/core';
import type { ExperimentRows } from './compare.js';

export async function loadExperimentRows(mastra: Mastra, experimentId: string): Promise<ExperimentRows> {
  const storage = mastra.getStorage();
  if (!storage) throw new Error('Storage not configured on this Mastra instance.');
  const experiments = await storage.getStore('experiments');
  const scores = await storage.getStore('scores');
  if (!experiments || !scores) throw new Error('Experiments or scores storage not configured.');

  const experiment = await experiments.getExperimentById({ id: experimentId });
  if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);

  const [results, scoreRows] = await Promise.all([
    experiments.listExperimentResults({ experimentId, pagination: { page: 0, perPage: false } }),
    scores.listScoresByRunId({ runId: experimentId, pagination: { page: 0, perPage: false } }),
  ]);

  return {
    id: experimentId,
    results: results.results.map(r => ({ itemId: r.itemId, attempt: (r as { attempt?: number }).attempt ?? null, error: r.error ?? null })),
    scores: scoreRows.scores.map(s => ({ scorerId: s.scorerId, entityId: s.entityId, score: s.score, attempt: attemptFromScoreId(s.id, s.entityId, s.scorerId) })),
  };
}

/**
 * Mastra's caller-driven experiments store scores with ids `expscore:<experiment>:<item>:<attempt>:<scorer>`
 * (experiment/scorer.ts stableScoreKey). Returns the attempt, or null for other ids.
 */
export function attemptFromScoreId(id: string | undefined, itemId: string, scorerId: string): number | null {
  if (!id) return null;
  const suffix = `:${scorerId}`;
  const marker = `:${itemId}:`;
  if (!id.startsWith('expscore:') || !id.endsWith(suffix)) return null;
  const at = id.lastIndexOf(marker, id.length - suffix.length);
  if (at < 0) return null;
  const attempt = id.slice(at + marker.length, id.length - suffix.length);
  return /^\d+$/.test(attempt) ? Number(attempt) : null;
}
