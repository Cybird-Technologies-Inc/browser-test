'use strict';
const js = require('@eslint/js');

module.exports = [
  { ignores: ['node_modules/', 'out/'] },
  js.configs.recommended,
  {
    languageOptions: {
      sourceType: 'commonjs',
      // Node globals only; the script's page.evaluate callbacks run in the browser.
      globals: {
        require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly',
        __dirname: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly',
        window: 'readonly', document: 'readonly', performance: 'readonly',
      },
    },
    rules: {
      // Deliberate best-effort catches (e.g. URL parsing) are used in the script.
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
