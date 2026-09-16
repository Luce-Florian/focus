'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 1 << 20;

/**
 * Local-only hook receiver. Identity travels in the URL, not in the payload:
 * the main process mints the Claude session uuid before the pane exists, so
 * `/h/<token>/<uuid>/<Event>` is already a resolved join at POST time.
 */
function startHooksServer({ host, onEvent }) {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST') return reply(405, { error: 'method not allowed' });

    const parts = req.url.split('/').filter(Boolean);
    if (parts.length !== 4 || parts[0] !== 'h') return reply(404, { error: 'not found' });
    const [, urlToken, uuid, event] = parts;
    if (urlToken !== token) return reply(403, { error: 'bad token' });

    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      if (tooBig) return;
      body += c;
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
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = { _parseError: body.slice(0, 500) };
      }
      onEvent({ uuid, event, payload });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => {
      resolve({ server, token, port: server.address().port });
    });
  });
}

module.exports = { startHooksServer };
