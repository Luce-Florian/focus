import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { computeRoot, assertProjectRoot, SESSIONS, HOOK_EVENTS } from '../../src/main/config.ts';

test('computeRoot resolves the repository root one level above the compiled bundle', () => {
  // dist/main.js sits one level below the repository root, unlike
  // src/main/config.js which sat two levels below it.
  assert.equal(computeRoot('/repo/dist'), '/repo');
});

test('assertProjectRoot accepts a directory that actually looks like the repository root', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'config-root-'));
  writeFileSync(path.join(dir, 'package.json'), '{}');
  try {
    assert.doesNotThrow(() => assertProjectRoot(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertProjectRoot fails fast when the resolved root is wrong', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'config-root-'));
  try {
    assert.throws(() => assertProjectRoot(dir), /package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the walking skeleton still drives exactly two sessions', () => {
  assert.deepEqual(SESSIONS.map((s) => s.label), ['alpha', 'beta']);
});

test('the arbiter subscribes to every hook event the fleet needs', () => {
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
