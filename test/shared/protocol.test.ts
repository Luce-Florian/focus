import test from 'node:test';
import assert from 'node:assert';

import { CLS, STATES, STATE_CLASS, CLASS_LABEL, hookUrl, parseHookPath } from '../../src/shared/protocol.ts';

void test('every session state maps to an attention class', () => {
  for (const state of Object.values(STATES)) {
    assert.ok(state in STATE_CLASS, `${state} has no class`);
  }
});

void test('attention classes are ordered so a stronger claim always compares higher', () => {
  // The comparisons below are statically true given CLS's `as const` literal
  // types — that's the point: this is a spec-level assertion about the
  // design (foreground priority order), not a search for a bug tsc would
  // miss, so the "always true" flag is expected rather than a real finding.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  assert.ok(CLS.GONE < CLS.RUNNING);
  assert.ok(CLS.RUNNING < CLS.IDLE);
  assert.ok(CLS.IDLE < CLS.WAIT_INPUT);
  assert.ok(CLS.WAIT_INPUT < CLS.WAIT_PERM);
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
});

void test('every class the foreground can show while claiming attention has a label', () => {
  for (const cls of [CLS.WAIT_PERM, CLS.WAIT_INPUT, CLS.IDLE, CLS.RUNNING, CLS.GONE]) {
    assert.equal(typeof CLASS_LABEL[cls], 'string');
  }
});

void test('a hook URL round-trips through the parser that routes it', () => {
  const parsed = parseHookPath(new URL(hookUrl('127.0.0.1', 8080, 'tok', 'uuid-1', 'Notification')).pathname);
  assert.deepEqual(parsed, { token: 'tok', uuid: 'uuid-1', event: 'Notification' });
});

void test('parseHookPath rejects anything that is not a hook path', () => {
  assert.equal(parseHookPath('/'), null);
  assert.equal(parseHookPath('/h/tok/uuid'), null);
  assert.equal(parseHookPath('/nope/tok/uuid/Stop'), null);
  assert.equal(parseHookPath('/h/tok/uuid/Stop/extra'), null);
});
