import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Ports, cols/rows and byte counts stringify exactly as intended; only
      // objects (-> "[object Object]") are worth flagging here.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }]
    }
  },
  {
    // Test doubles legitimately need no-op stub methods (fakeStore, a fake
    // timer's unref()); production code never does.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': ['error', { allow: ['methods', 'arrowFunctions'] }]
    }
  },
  {
    // Electron main, the preload bundle and the test suite all run under Node.
    files: ['src/main/**/*.ts', 'src/preload.ts', 'src/shared/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    // The renderer runs in Chromium, with no Node globals (contextIsolation).
    files: ['src/renderer/**/*.ts'],
    languageOptions: { globals: globals.browser }
  }
);
