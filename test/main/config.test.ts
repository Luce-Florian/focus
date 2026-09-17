import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  computeRoot,
  assertProjectRoot,
  SESSIONS,
  HOOK_EVENTS,
  MAX_SESSIONS,
  MODELS,
  SESSION_END_MARKER,
  BOOT_TIMEOUT_MS
} from '../../src/main/config.ts';
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

void test('the fleet starts empty: sessions come from the interface, not from this file', () => {
  assert.deepEqual(SESSIONS, []);
});

void test('the ceiling is a whole number of sessions', () => {
  // A fractional or infinite ceiling would make `liveCount() >= MAX_SESSIONS`
  // either unreachable or off by one at the boundary.
  assert.ok(Number.isSafeInteger(MAX_SESSIONS));
});

void test('exactly one model option means "no --model flag"', () => {
  assert.equal(MODELS.filter((m) => m.id === '').length, 1);
  assert.ok(MODELS.every((m) => m.label.length > 0));
});

void test('model ids are unique, because the factory whitelists on them', () => {
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
});

void test('the end marker is pure ASCII, because pane output is matched byte for byte', () => {
  // `%output` is read as latin1, one char per byte. A non-ASCII marker would
  // arrive as its UTF-8 bytes and never match the string compared against it.
  assert.equal(Buffer.byteLength(SESSION_END_MARKER, 'utf8'), SESSION_END_MARKER.length);
  assert.doesNotMatch(SESSION_END_MARKER, /[^\x20-\x7e]/);
});

void test('the boot backstop is a whole number of milliseconds', () => {
  assert.ok(Number.isSafeInteger(BOOT_TIMEOUT_MS));
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
