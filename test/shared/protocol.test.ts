import test from 'node:test';
import assert from 'node:assert';

import { CLS, STATES, STATE_CLASS, CLASS_LABEL } from '../../src/shared/protocol.ts';

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
