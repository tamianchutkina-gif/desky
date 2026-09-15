import js from '@eslint/js';
import globals from 'globals';

/**
 * Three kinds of file, three sets of globals. The rule set is the
 * recommended one and nothing stylistic: the point is to catch the
 * undefined name or the unused import in a renderer no test imports,
 * not to argue about commas.
 */
export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'packages/host/release/**',
      'packages/host/shared/**',
      'packages/host/renderer/fonts/**',
      'downloads/**',
      'dist/**',
    ],
  },
  {
    // Node: the server, the agent's main process, scripts, tests.
    files: [
      'packages/server/src/**/*.js',
      'packages/host/src/**/*.{js,cjs}',
      'packages/host/build/**/*.cjs',
      'scripts/**/*.{js,mjs,cjs}',
      'tests/**/*.mjs',
      'shared/**/*.js',
      'eslint.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // Browser: the operator console and the agent's renderers. `window.desky`
    // is what each preload exposes.
    files: ['packages/server/public/**/*.js', 'packages/host/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
