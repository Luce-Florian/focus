import test from 'node:test';
import assert from 'node:assert';

import { CLS, STATES, STATE_CLASS, CLASS_LABEL } from '../../src/shared/protocol.ts';

test('every session state maps to an attention class', () => {
  for (const state of Object.values(STATES)) {
    assert.ok(state in STATE_CLASS, `${state} has no class`);
  }
});

test('attention classes are ordered so a stronger claim always compares higher', () => {
  assert.ok(CLS.GONE < CLS.RUNNING);
  assert.ok(CLS.RUNNING < CLS.IDLE);
  assert.ok(CLS.IDLE < CLS.WAIT_INPUT);
  assert.ok(CLS.WAIT_INPUT < CLS.WAIT_PERM);
});

test('every class the foreground can show while claiming attention has a label', () => {
  for (const cls of [CLS.WAIT_PERM, CLS.WAIT_INPUT, CLS.IDLE, CLS.RUNNING, CLS.GONE]) {
    assert.equal(typeof CLASS_LABEL[cls], 'string');
  }
});
