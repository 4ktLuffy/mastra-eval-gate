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
    status: (experiment as { status?: string }).status ?? null,
    datasetVersion: (experiment as { datasetVersion?: number | null }).datasetVersion ?? null,
    results: results.results.map(r => {
      const row = r as { attempt?: number; startedAt?: Date | string; completedAt?: Date | string; output?: unknown };
      const started = row.startedAt ? new Date(row.startedAt).getTime() : Number.NaN;
      const completed = row.completedAt ? new Date(row.completedAt).getTime() : Number.NaN;
      return {
        itemId: r.itemId,
        attempt: row.attempt ?? null,
        error: r.error ?? null,
        durationMs: Number.isFinite(completed - started) ? completed - started : null,
        tokens: totalTokens(row.output),
      };
    }),
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

/**
 * Total tokens from an agent target's output. Mastra's `usage` is the last step only; `totalUsage`
 * covers every step of the run, so it comes first.
 */
export function totalTokens(output: unknown): number | null {
  const o = output as { usage?: { totalTokens?: unknown }; totalUsage?: { totalTokens?: unknown } } | null;
  const t = o?.totalUsage?.totalTokens ?? o?.usage?.totalTokens;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}
