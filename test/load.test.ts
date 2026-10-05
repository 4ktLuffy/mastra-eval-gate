import { describe, expect, it } from 'vitest';
import { attemptFromScoreId, totalTokens } from '../src/load.js';

describe('attemptFromScoreId', () => {
  it('reads the attempt from a caller-driven score id', () => {
    expect(attemptFromScoreId('expscore:exp-1:item-9:2:quality', 'item-9', 'quality')).toBe(2);
  });
  it('handles ids and scorer names containing colons', () => {
    expect(attemptFromScoreId('expscore:e:it:em:0:my:scorer', 'it:em', 'my:scorer')).toBe(0);
  });
  it('returns null for runner score ids and mismatches', () => {
    expect(attemptFromScoreId('3f1c9a52-uuid', 'item-9', 'quality')).toBeNull();
    expect(attemptFromScoreId(undefined, 'item-9', 'quality')).toBeNull();
    expect(attemptFromScoreId('expscore:exp-1:item-9:x:quality', 'item-9', 'quality')).toBeNull();
    expect(attemptFromScoreId('expscore:exp-1:item-9:1:other', 'item-9', 'quality')).toBeNull();
  });
});

describe('totalTokens', () => {
  it('reads usage.totalTokens or totalUsage.totalTokens', () => {
    expect(totalTokens({ usage: { totalTokens: 12 } })).toBe(12);
    expect(totalTokens({ totalUsage: { totalTokens: 7 } })).toBe(7);
    expect(totalTokens({ text: 'x' })).toBeNull();
    expect(totalTokens(null)).toBeNull();
  });
});
