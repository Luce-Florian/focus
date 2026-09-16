import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeSessionSettings } from '../../src/main/session-settings.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-settings-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the settings file merges hooks and forces real permission prompts', () => {
  withTempDir((runDir) => {
    const file = writeSessionSettings({
      runDir,
      uuid: 'abc-123',
      host: '127.0.0.1',
      port: 4321,
      token: 'tok',
      events: ['SessionStart', 'PreToolUse', 'Notification']
    });

    assert.equal(file, path.join(runDir, 'abc-123.settings.json'));
    const settings = JSON.parse(readFileSync(file, 'utf8'));

    assert.equal(settings.permissions.defaultMode, 'default');
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].url,
      'http://127.0.0.1:4321/h/tok/abc-123/SessionStart'
    );
  });
});

test('PreToolUse / PostToolUse hooks carry a wildcard matcher, the rest do not', () => {
  withTempDir((runDir) => {
    const file = writeSessionSettings({
      runDir,
      uuid: 'abc-123',
      host: '127.0.0.1',
      port: 4321,
      token: 'tok',
      events: ['PreToolUse', 'Stop']
    });
    const settings = JSON.parse(readFileSync(file, 'utf8'));

    assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
    assert.equal(settings.hooks.Stop[0].matcher, undefined);
  });
});
