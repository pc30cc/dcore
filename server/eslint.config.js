// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/**', '**/node_modules/**', '**/.astro/**', '**/coverage/**']),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // Fastify handlers and hooks are async by contract, with or without an await.
      '@typescript-eslint/require-await': 'off',
      // process.env['NAME'] reads better than process.env.NAME for variables.
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },

  // Config files are linted without type information (they belong to no app's tsconfig).
  {
    files: ['**/*.{js,mjs,cjs}', '**/vite.config.ts', '**/vitest.config.ts', 'apps/web/astro.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // The admin panel runs in browsers.
  {
    files: ['apps/admin/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },

  // The admin panel and the website never load the Node-only part of the shared package.
  {
    files: ['apps/admin/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@app/shared/server', '@app/shared/server/*'], message: 'Node only: never in the admin panel or the website.' }] },
      ],
    },
  },

  // Tests may poke at values they just asserted on.
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
