import test from 'node:test';
import assert from 'node:assert';

import { decodeOutput, toHexKeys } from '../../src/main/tmux.ts';

void test('plain ASCII passes through untouched', () => {
  assert.deepEqual(decodeOutput('hello'), Buffer.from('hello', 'latin1'));
});

void test('three-digit octal escapes decode to their byte (tab, backslash, ESC)', () => {
  assert.deepEqual(decodeOutput('a\\011b'), Buffer.from([0x61, 0x09, 0x62]));
  assert.deepEqual(decodeOutput('\\134'), Buffer.from([0x5c]));
  assert.deepEqual(decodeOutput('\\033[1m'), Buffer.concat([Buffer.from([0x1b]), Buffer.from('[1m', 'latin1')]));
});

void test('a lone backslash that is not a valid octal escape is kept as a byte', () => {
  assert.deepEqual(decodeOutput('a\\9zz'), Buffer.from('a\\9zz', 'latin1'));
});

void test('bytes >= 0x80 pass through raw when the stream was read as latin1', () => {
  // UTF-8 "é" (0xc3 0xa9) round-tripped through latin1 char codes.
  const latin1Chars = Buffer.from('é', 'utf8').toString('latin1');
  assert.deepEqual(decodeOutput(latin1Chars), Buffer.from('é', 'utf8'));
});

void test('toHexKeys turns UTF-8 bytes into lowercase two-digit hex, one per byte', () => {
  assert.deepEqual(toHexKeys('AB'), ['41', '42']);
  assert.deepEqual(toHexKeys('é'), ['c3', 'a9']);
});
