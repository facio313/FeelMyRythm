import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/server/**',
      'packages/protocol/src/openapi.ts',
      'eslint.config.js',
      'vitest.workspace.ts',
      '**/vite.config.ts',
      '**/vitest.config.ts',
      'playwright.config.ts',
      'e2e/playwright-report/**',
      'e2e/test-results/**',
      'apps/mobile/android/.gradle/**',
      'apps/mobile/android/**/build/**',
      'apps/mobile/android/app/src/main/assets/public/**',
      'apps/mobile/web/**',
      'apps/mobile/ios/**/DerivedData/**',
      'apps/mobile/ios/App/App/public/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['apps/mobile/scripts/**/*.mjs'],
  },
);
