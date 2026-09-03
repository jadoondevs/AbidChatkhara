// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'apps/frontend/dist/**',
      // The print agent is a standalone Node service (plain ESM JS, no
      // TypeScript) with its own `npm test`. This flat config is written
      // for the TypeScript workspaces and has no Node globals wired in,
      // so it is linted on its own terms, not swept in here. See agent/.
      'agent/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // Money values must be branded Paisa produced only by platform/money helpers.
      // A stray `/` or `*` on a Paisa-typed operand outside that module is caught by
      // the type-aware guard in tools/money-arithmetic-guard (run as a vitest test:
      // see packages/shared/src/money/no-bare-arithmetic.test.ts), because a flat
      // ESLint rule cannot see TypeScript's structural branding without full
      // type information wired through typescript-eslint's project service, which
      // is expensive to run in CI on every save. The test runs the same compiler
      // Program vitest already type-checks with, so it costs nothing extra.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Route handlers and services log through Fastify's request/app
      // logger, which carries request context console.* cannot. The
      // handful of legitimate exceptions (process bootstrap before the
      // logger exists, the event bus's own failure path) disable this
      // inline with a comment explaining why.
      'no-console': 'warn',
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='=='], BinaryExpression[operator='!=']",
          message: 'Use === / !== (no implicit coercion in money or business logic).',
        },
      ],
    },
  },
);
