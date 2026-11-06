import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'e2e/.dist/**', 'e2e/test-results/**', 'e2e/playwright-report/**', '**/node_modules/**', '**/cdk.out/**', 'frontend/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { URL: 'readonly', fetch: 'readonly', process: 'readonly', console: 'readonly' } } },
);
