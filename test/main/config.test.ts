import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { computeRoot, assertProjectRoot, SESSIONS, HOOK_EVENTS } from '../../src/main/config.ts';
import { withTempDir } from '../helpers/tmp.ts';

void test('computeRoot resolves the same repository root from every bundle depth', () => {
  // esbuild emits dist/main.js one level below the root and one bundle per
  // test file under dist/test/**, each with its own import.meta.dirname.
  // Counting `..` was only ever right for the first of them.
  withTempDir((root) => {
    writeFileSync(path.join(root, 'package.json'), '{}');
    const deep = path.join(root, 'dist', 'test', 'main');
    mkdirSync(deep, { recursive: true });

    assert.equal(computeRoot(path.join(root, 'dist')), root);
    assert.equal(computeRoot(path.join(root, 'dist', 'test')), root);
    assert.equal(computeRoot(deep), root);
  });
});

void test('computeRoot fails loudly rather than returning a nonsense root', () => {
  assert.throws(() => computeRoot(path.parse(process.cwd()).root), /no package\.json/);
});

void test('assertProjectRoot accepts a directory that actually looks like the repository root', () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, 'package.json'), '{}');
    assert.doesNotThrow(() => { assertProjectRoot(dir); });
  }, 'config-root-');
});

void test('assertProjectRoot fails fast when the resolved root is wrong', () => {
  withTempDir((dir) => {
    assert.throws(() => { assertProjectRoot(dir); }, /package\.json/);
  }, 'config-root-');
});

void test('the walking skeleton still drives exactly two sessions', () => {
  assert.deepEqual(SESSIONS.map((s) => s.label), ['alpha', 'beta']);
});

void test('the arbiter subscribes to every hook event the fleet needs', () => {
  assert.deepEqual(HOOK_EVENTS, [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'SessionEnd'
  ]);
});
