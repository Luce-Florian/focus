import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import { startHooksServer } from '../../src/main/hooks-server.ts';
import type { HookEventMessage } from '../../src/shared/protocol.ts';

function rawPost(port: number, urlPath: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      },
      (res) => {
        res.resume();
        res.on('end', () => { resolve(res.statusCode ?? 0); });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const post = (port: number, urlPath: string, json: unknown) => rawPost(port, urlPath, JSON.stringify(json));

void test('a correctly-authenticated POST decodes uuid, event and payload from the URL', async () => {
  const events: HookEventMessage[] = [];
  const hooks = await startHooksServer({ host: '127.0.0.1', onEvent: (e) => events.push(e) });
  try {
    const status = await post(hooks.port, `/h/${hooks.token}/abc-123/Notification`, { message: 'hi' });
    assert.equal(status, 200);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, [{ uuid: 'abc-123', event: 'Notification', payload: { message: 'hi' } }]);
  } finally {
    hooks.server.close();
  }
});

void test('a wrong token is rejected before the event ever reaches the arbiter', async () => {
  const events: HookEventMessage[] = [];
  const hooks = await startHooksServer({ host: '127.0.0.1', onEvent: (e) => events.push(e) });
  try {
    const status = await post(hooks.port, '/h/not-the-token/abc-123/Notification', {});
    assert.equal(status, 403);
    assert.deepEqual(events, []);
  } finally {
    hooks.server.close();
  }
});

void test('a malformed JSON body is captured as _parseError instead of throwing', async () => {
  const events: HookEventMessage[] = [];
  const hooks = await startHooksServer({ host: '127.0.0.1', onEvent: (e) => events.push(e) });
  try {
    const status = await rawPost(hooks.port, `/h/${hooks.token}/abc-123/Stop`, '{not json');
    assert.equal(status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload._parseError, '{not json');
  } finally {
    hooks.server.close();
  }
});

void test('a GET request is rejected, a malformed URL is 404', async () => {
  const hooks = await startHooksServer({ host: '127.0.0.1', onEvent: () => {} });
  try {
    const get = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: hooks.port, path: '/h/x/y/z', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => { resolve(res.statusCode ?? 0); });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(get, 405);

    const badPath = await post(hooks.port, '/nope', {});
    assert.equal(badPath, 404);
  } finally {
    hooks.server.close();
  }
});
