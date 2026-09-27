import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { claudeProfile, resolveClaudeBin } from '../../../../src/infrastructure/agents/claude/profile.ts';
import { writeSessionSettings, type ClaudeSessionSettings } from '../../../../src/infrastructure/agents/claude/settings-writer.ts';
import { HOOK_EVENT_NAMES, translate } from '../../../../src/infrastructure/agents/claude/events.ts';
import { MODELS } from '../../../../src/infrastructure/agents/claude/models.ts';
import { withTempDir } from '../../../helpers/tmp.ts';

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
      token: 'tok'
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
    const file = writeSessionSettings({ runDir, uuid: 'abc-123', host: '127.0.0.1', port: 4321, token: 'tok' });
    const settings = JSON.parse(readFileSync(file, 'utf8')) as ParsedSettings;

    assert.equal(first(settings.hooks.PreToolUse).matcher, '*');
    assert.equal(first(settings.hooks.Stop).matcher, undefined);
  });
});

// ---- the anti-corruption layer: raw Claude hooks → domain events ----

void test('tool and prompt events translate to progress', () => {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    assert.deepEqual(translate(event, {}), { kind: 'progress', reason: 'travaille' });
  }
});

void test('a Notification about input translates to waiting-input, anything else to a permission', () => {
  assert.deepEqual(translate('Notification', { message: 'Claude is waiting for your input' }), {
    kind: 'waiting-input',
    reason: 'Claude is waiting for your input'
  });
  assert.deepEqual(translate('Notification', { message: 'Claude needs your permission to use Bash' }), {
    kind: 'waiting-perm',
    reason: 'Claude needs your permission to use Bash'
  });
  // A message-less Notification is still a blocking permission by default.
  assert.deepEqual(translate('Notification', {}), { kind: 'waiting-perm', reason: 'permission demandée' });
});

void test('Stop and SessionEnd translate to their domain counterparts', () => {
  assert.deepEqual(translate('Stop', {}), { kind: 'stop', reason: 'tour terminé' });
  assert.deepEqual(translate('SessionEnd', {}), { kind: 'ended', reason: 'session terminée' });
});

void test('an unknown event translates to nothing', () => {
  assert.equal(translate('SomethingNew', {}), null);
});

void test('every declared hook event translates to something', () => {
  for (const event of HOOK_EVENT_NAMES) {
    assert.notEqual(translate(event, {}), null, `${event} carries no meaning for the policy`);
  }
});

// ---- the profile: command lines the fleet can trust ----

void test('exactly one model option means "no --model flag"', () => {
  assert.equal(MODELS.filter((m) => m.id === '').length, 1);
  assert.ok(MODELS.every((m) => m.label.length > 0));
});

void test('model ids are unique, because the use case whitelists on them', () => {
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
});

void test('the profile builds the launch line with the prompt positional, last', () => {
  withTempDir((runDir) => {
    const p = claudeProfile({ bin: '/usr/local/bin/claude', runDir });
    const cmd = p.launch({ uuid: 'u-1', model: 'sonnet', settingsFile: '/run/u-1.settings.json', prompt: 'go' });
    assert.ok(cmd.includes("'/usr/local/bin/claude'"));
    assert.ok(cmd.includes('--session-id') && cmd.includes("'u-1'"));
    assert.ok(cmd.includes('--model') && cmd.includes("'sonnet'"));
    assert.ok(cmd.includes('--settings'));
    assert.ok(cmd.indexOf("'go'") > cmd.indexOf('--settings'), 'the prompt is positional');
  });
});

void test('the profile builds the resume line with no prompt replay', () => {
  withTempDir((runDir) => {
    const p = claudeProfile({ bin: '/usr/local/bin/claude', runDir });
    const cmd = p.resume({ uuid: 'u-1', model: '', settingsFile: '/run/u-1.settings.json' });
    assert.ok(cmd.includes('--resume') && cmd.includes("'u-1'"));
    assert.ok(!cmd.includes('--model'));
  });
});

void test('the profile writes the same settings file the adapter writes', () => {
  withTempDir((runDir) => {
    const p = claudeProfile({ bin: '/usr/local/bin/claude', runDir });
    const file = p.writeSettings({ runDir, uuid: 'abc-123', host: '127.0.0.1', port: 4321, token: 'tok' });
    assert.equal(file, path.join(runDir, 'abc-123.settings.json'));
  });
});

void test('the profile names, and recognises, its own settings file', () => {
  withTempDir((runDir) => {
    const p = claudeProfile({ bin: '/usr/local/bin/claude', runDir });
    const uuid = '11111111-1111-4111-8111-111111111111';
    const written = p.writeSettings({ runDir, uuid, host: '127.0.0.1', port: 4321, token: 'tok' });
    assert.equal(p.settingsFile(runDir, uuid), written, 'the name is announced before the file exists');
    assert.equal(p.settingsOwner(path.basename(written)), uuid);
    assert.equal(p.settingsOwner('fleet.db'), null, 'the run directory holds more than settings');
    assert.equal(p.settingsOwner(`codex-${uuid}.conf`), null, "another agent's file is not claimed");
  });
});

void test('resolveClaudeBin falls back to the bare name when which fails', () => {
  // No assertion on the resolved path: this runs on machines where claude
  // exists. The fallback is exercised by the smoke stub instead.
  assert.equal(typeof resolveClaudeBin(), 'string');
});