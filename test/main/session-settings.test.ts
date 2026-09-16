import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { writeSessionSettings, type ClaudeSessionSettings } from '../../src/main/session-settings.ts';
import { withTempDir } from '../helpers/tmp.ts';

// The shape under test is the production one, so a change to the settings
// file's structure breaks this test instead of silently drifting past it.
type ParsedSettings = ClaudeSessionSettings;

function first<T>(arr: readonly T[] | undefined): T {
  const item = arr?.[0];
  assert.ok(item, 'expected a first element');
  return item;
}

void test('the settings file merges hooks and forces real permission prompts', () => {
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
    const settings = JSON.parse(readFileSync(file, 'utf8')) as ParsedSettings;

    assert.equal(settings.permissions.defaultMode, 'default');
    assert.equal(
      first(first(settings.hooks.SessionStart).hooks).url,
      'http://127.0.0.1:4321/h/tok/abc-123/SessionStart'
    );
  });
});

void test('PreToolUse / PostToolUse hooks carry a wildcard matcher, the rest do not', () => {
  withTempDir((runDir) => {
    const file = writeSessionSettings({
      runDir,
      uuid: 'abc-123',
      host: '127.0.0.1',
      port: 4321,
      token: 'tok',
      events: ['PreToolUse', 'Stop']
    });
    const settings = JSON.parse(readFileSync(file, 'utf8')) as ParsedSettings;

    assert.equal(first(settings.hooks.PreToolUse).matcher, '*');
    assert.equal(first(settings.hooks.Stop).matcher, undefined);
  });
});
