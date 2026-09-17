import js from '@eslint/js'
import globals from 'globals'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

/**
 * Flat config. Deliberately small: a linter that flags 400 stylistic
 * complaints on a fresh clone is a linter people turn off. Formatting belongs
 * to Prettier; these rules are the ones that catch bugs.
 */
export default [
  { ignores: ['frontend/dist/**', 'node_modules/**', 'storage/**', 'coverage/**'] },

  js.configs.recommended,

  // ---------------------------------------------------------- backend (CJS)
  {
    // .cjs too: ecosystem.config.cjs is CommonJS and needs the Node globals.
    files: ['**/*.js', '**/*.cjs'],
    ignores: ['frontend/**', 'e2e/**', '*.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // An unused argument is often a real mistake; a deliberately ignored one
      // is conventionally prefixed with an underscore.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `catch {}` with no binding is the intentional form. An empty block
      // with a bound error is usually a swallowed failure.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // The logger writes structured lines; a stray console.log bypasses the
      // request id and the redaction.
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      // `await` inside a loop is correct for sequential work and wrong for
      // independent work. Flagged as a prompt to think, not an error.
      'no-await-in-loop': 'off',
      // Catches `if (a = b)` and the accidental comma operator.
      'no-cond-assign': ['error', 'always'],
      'no-sequences': 'error',
    },
  },

  // ---------------------------------------------------------- frontend (ESM)
  {
    files: ['frontend/**/*.{js,vue}', 'e2e/**/*.js', '*.config.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },

  // ---------------------------------------------------------- vue components
  ...vue.configs['flat/recommended'],
  {
    files: ['frontend/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
      globals: { ...globals.browser },
    },
    rules: {
      // Prettier owns line breaks and attribute wrapping.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      // These two catch real bugs: a v-for without a key re-uses DOM nodes
      // across items, and v-if on the same element as v-for evaluates before
      // the item exists.
      'vue/require-v-for-key': 'error',
      'vue/no-use-v-if-with-v-for': 'error',
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
    },
  },

  // ---------------------------------------------------------- tests
  {
    files: ['tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
    },
  },
]
