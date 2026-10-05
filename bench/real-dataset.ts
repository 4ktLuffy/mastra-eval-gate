/**
 * A deterministic set of multi-step arithmetic word problems with exact answers, so the agent's
 * correctness is checked by code, not by another model. Difficulty = number of steps (1-5).
 */
import { rng } from '../src/stats.js';

export interface Problem {
  id: string;
  steps: number;
  question: string;
  answer: number;
}

const THINGS = ['apples', 'boxes', 'tickets', 'books', 'parcels', 'chairs', 'coins', 'bottles'];

export function problems(count = 30, seed = 2026): Problem[] {
  const u = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(u() * (hi - lo + 1));
  const out: Problem[] = [];
  for (let i = 0; i < count; i++) {
    const steps = 1 + (i % 5);
    const thing = THINGS[int(0, THINGS.length - 1)]!;
    let value = int(20, 90);
    const parts = [`A warehouse starts with ${value} ${thing}.`];
    for (let s = 0; s < steps; s++) {
      const op = int(0, 3);
      if (op === 0) {
        const n = int(3, 9), k = int(4, 12);
        parts.push(`It receives ${n} crates of ${k} ${thing} each.`);
        value += n * k;
      } else if (op === 1) {
        const n = int(1, Math.max(1, Math.floor(value / 3)));
        parts.push(`It ships out ${n} ${thing}.`);
        value -= n;
      } else if (op === 2) {
        parts.push(`Then the stock is doubled.`);
        value *= 2;
      } else {
        const r = value % 4;
        parts.push(`Then ${r} damaged ${thing} are thrown away and the rest are split equally into 4 rooms; one room's share is kept and the other rooms are emptied.`);
        value = (value - r) / 4;
      }
    }
    parts.push(`How many ${thing} are in the warehouse at the end?`);
    out.push({ id: `p${String(i + 1).padStart(2, '0')}`, steps, question: parts.join(' '), answer: value });
  }
  return out;
}

/** The last integer in a reply. */
export function lastInteger(text: string): number | null {
  const all = text.replace(/,/g, '').match(/-?\d+/g);
  return all ? Number(all[all.length - 1]) : null;
}

/** All items of a Mastra dataset (listItems pages 20 at a time by default, and may return an array). */
export async function allItems(ds: { listItems(args?: { perPage?: number }): Promise<unknown> }): Promise<Array<{ id: string; input: unknown }>> {
  const r = (await ds.listItems({ perPage: 1000 })) as Array<{ id: string; input: unknown }> | { items: Array<{ id: string; input: unknown }> };
  return Array.isArray(r) ? r : r.items;
}
