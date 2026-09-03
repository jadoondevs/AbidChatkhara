// The HTTP contract the POS browser talks to:
//
//   GET  /health -> 200 {ok:true} if the printer is reachable, else 503.
//                   Prints nothing, uses no paper. Safe to poll.
//   POST /print  -> prints. 200 {ok:true} on success; any non-200 means
//                   nothing printed.
//
// Everything is localhost. CORS is wide open because the only callers
// are pages on this same machine (the till's own POS), and the agent has
// nothing worth protecting from them — it prints receipts.

import { createServer } from 'node:http';
import { render } from './escpos.js';

const MAX_BODY = 256 * 1024; // a ticket is small; refuse anything absurd

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Build the HTTP server. `printer` is anything with `healthy()` and
 * `print(bytes)` — the real one in printer.js, or a fake in tests.
 */
export function createAgentServer(printer, { density = 0, log = () => {} } = {}) {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const ok = await printer.healthy().catch(() => false);
      json(res, ok ? 200 : 503, { ok });
      return;
    }

    if (req.method === 'POST' && req.url === '/print') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      let bytes;
      try {
        bytes = render(payload, density);
      } catch (err) {
        json(res, 400, { ok: false, error: String(err.message ?? err) });
        return;
      }
      try {
        await printer.print(bytes);
        log(`printed ${payload.kind} (${bytes.length} bytes)`);
        json(res, 200, { ok: true });
      } catch (err) {
        // Any failure here means nothing came out — say so plainly, so
        // the till shows the cashier a retry rather than assuming a
        // receipt on the counter.
        log(`print failed: ${String(err.message ?? err)}`);
        json(res, 500, { ok: false, error: 'printer did not accept the job' });
      }
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  });
}
