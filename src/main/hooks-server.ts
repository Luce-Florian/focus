import crypto from 'node:crypto';
import http from 'node:http';

import { parseHookPath, type HookEventMessage, type HookPayload } from '../shared/protocol.ts';

const MAX_BODY = 1 << 20;

export interface StartHooksServerOptions {
  readonly host: string;
  readonly onEvent: (message: HookEventMessage) => void;
}

export interface HooksServer {
  readonly server: http.Server;
  readonly token: string;
  readonly port: number;
}

type ReplyBody = Record<string, unknown>;

/**
 * Local-only hook receiver. Identity travels in the URL, not in the payload:
 * the main process mints the Claude session uuid before the pane exists, so
 * `/h/<token>/<uuid>/<Event>` is already a resolved join at POST time.
 */
export function startHooksServer({ host, onEvent }: StartHooksServerOptions): Promise<HooksServer> {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const reply = (code: number, body: ReplyBody) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST') {
      reply(405, { error: 'method not allowed' });
      return;
    }

    const identity = parseHookPath(req.url ?? '');
    if (!identity) {
      reply(404, { error: 'not found' });
      return;
    }
    const { uuid, event } = identity;
    if (identity.token !== token) {
      reply(403, { error: 'bad token' });
      return;
    }

    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        reply(413, { error: 'payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      // The arbiter only observes: answer immediately so no session ever
      // blocks on the UI, then process.
      reply(200, {});
      let payload: HookPayload = {};
      try {
        payload = body ? (JSON.parse(body) as HookPayload) : {};
      } catch {
        payload = { _parseError: body.slice(0, 500) };
      }
      onEvent({ uuid, event, payload });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('hooks server has no port after listen()'));
        return;
      }
      resolve({ server, token, port: address.port });
    });
  });
}
