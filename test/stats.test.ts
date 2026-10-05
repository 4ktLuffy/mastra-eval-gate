import { describe, expect, it } from 'vitest';
import {
  bootstrapMeanCI,
  holm,
  mcnemarExactPValue,
  minimumDetectableEffect,
  normalQuantile,
  signFlipPValue,
} from '../src/stats.js';

describe('signFlipPValue', () => {
  it('is 1/2^n when every diff is negative (exact)', () => {
    expect(signFlipPValue([-0.1, -0.2, -0.1, -0.3, -0.2])).toBeCloseTo(1 / 32, 12);
  });
  it('is 1 when nothing changed', () => {
    expect(signFlipPValue([0, 0, 0, 0])).toBe(1);
  });
  it('accounts for the tolerance', () => {
    // Every item drops by 0.05; with tolerance 0.05 that is not a regression.
    expect(signFlipPValue([-0.05, -0.05, -0.05, -0.05, -0.05], 0.05)).toBe(1);
    expect(signFlipPValue([-0.05, -0.05, -0.05, -0.05, -0.05], 0)).toBeCloseTo(1 / 32, 12);
  });
  it('Monte Carlo matches exact on the same data', () => {
    const d = Array.from({ length: 16 }, (_, i) => (i % 3 === 0 ? 0.1 : -0.08));
    const exact = signFlipPValue(d);
    const mc = signFlipPValue([...d, 0], 0, { resamples: 50000, seed: 7 }); // n=17 forces Monte Carlo
    expect(Math.abs(exact - mc)).toBeLessThan(0.01);
  });
});

describe('mcnemarExactPValue', () => {
  it('3 new failures, none fixed', () => expect(mcnemarExactPValue(3, 0)).toBeCloseTo(0.125, 12));
  it('no discordant pairs', () => expect(mcnemarExactPValue(0, 0)).toBe(1));
  it('balanced', () => expect(mcnemarExactPValue(2, 2)).toBeCloseTo(11 / 16, 12));
});

describe('holm', () => {
  it('matches the textbook example', () => {
    const adj = holm([0.01, 0.04, 0.03]);
    expect(adj[0]).toBeCloseTo(0.03, 12);
    expect(adj[1]).toBeCloseTo(0.06, 12);
    expect(adj[2]).toBeCloseTo(0.06, 12);
  });
  it('passes NaN through', () => expect(holm([Number.NaN, 0.02])).toEqual([Number.NaN, 0.02]));
});

describe('normalQuantile / MDE', () => {
  it('z(0.975)', () => expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5));
  it('z(0.05) is negative', () => expect(normalQuantile(0.05)).toBeCloseTo(-1.644854, 5));
  it('MDE shrinks with sqrt(n)', () => {
    expect(minimumDetectableEffect(0.2, 100) / minimumDetectableEffect(0.2, 25)).toBeCloseTo(0.5, 10);
  });
});

describe('bootstrapMeanCI', () => {
  it('is reproducible and brackets the mean', () => {
    const xs = [0.1, -0.2, 0.05, 0, -0.1, 0.3, -0.05];
    const ci = bootstrapMeanCI(xs, { seed: 3 });
    expect(bootstrapMeanCI(xs, { seed: 3 })).toEqual(ci);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(ci[0]).toBeLessThanOrEqual(m);
    expect(ci[1]).toBeGreaterThanOrEqual(m);
  });
});
