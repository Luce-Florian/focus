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
    // Hexagonal boundary, enforced rather than documented: the domain stays
    // pure (no application, no infrastructure, no shared façade), and the
    // application talks to ports, never to adapters.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/infrastructure/**', '**/shared/**'],
              message: 'the domain stays pure: no application, infrastructure or shared imports'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**'],
              message: 'the application talks to ports, not to adapters'
            }
          ]
        }
      ]
    }
  },
  {
    // The sandboxed processes see the façade and nothing else: `protocol.ts`
    // is the only layer the UI is allowed to import.
    files: ['src/renderer/**/*.ts', 'src/preload.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/domain/**', '**/application/**', '**/infrastructure/**'],
              message: 'the UI imports shared/protocol.ts, never a layer directly'
            }
          ]
        }
      ]
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
    files: [
      'src/domain/**/*.ts',
      'src/application/**/*.ts',
      'src/infrastructure/**/*.ts',
      'src/preload.ts',
      'src/shared/**/*.ts',
      'test/**/*.ts'
    ],
    languageOptions: { globals: globals.node }
  },
  {
    // The renderer runs in Chromium, with no Node globals (contextIsolation).
    files: ['src/renderer/**/*.ts'],
    languageOptions: { globals: globals.browser }
  }
);