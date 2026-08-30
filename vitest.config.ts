import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The money-arithmetic guard type-checks the whole workspace with the
    // TypeScript compiler API; give it room on slower machines.
    testTimeout: 30_000,
    passWithNoTests: false,
  },
});
