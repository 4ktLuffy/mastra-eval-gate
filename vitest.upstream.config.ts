import { defineConfig } from 'vitest/config';

// Runs the upstream patch's own test file (it only needs ../compare and ../aggregate at runtime).
export default defineConfig({
  test: { include: ['upstream/mastra/packages/core/src/datasets/experiment/analytics/__tests__/*.test.ts'] },
});
