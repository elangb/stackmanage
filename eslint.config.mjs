import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } }, rules: { 'vue/multi-word-component-names': 'off', 'vue/html-self-closing': 'off', 'vue/max-attributes-per-line': 'off', 'vue/singleline-html-element-content-newline': 'off' } },
  { files: ['**/*.{ts,mjs,vue}'], languageOptions: { globals: { console: 'readonly', process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', window: 'readonly', document: 'readonly' } } }
);
