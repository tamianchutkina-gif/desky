import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { WebSocketServer } from 'ws';

import { config, ROOT, REPO_ROOT, newId } from './config.js';
import { Hub } from './hub.js';
import { createStaticHandler } from './static.js';
import { createInstallHandler } from './install.js';
import { turnConfigured } from './turn.js';
import { MSG } from '../../../shared/protocol.js';

const hub = new Hub();

const serveStatic = createStaticHandler([
  { prefix: '/shared', dir: path.join(REPO_ROOT, 'shared') },
  // The packaged agent. Ahead of the public mount because it is the one
  // path served from outside the repository; a missing directory falls
  // through to a 404 rather than failing the request.
  { prefix: '/download', dir: config.downloadDir },
  { prefix: '/', dir: path.join(ROOT, 'public') },
]);

// Claims /install and /install.sh before the static mount above can
// serve the unsubstituted originals. See install.js.
const serveInstall = createInstallHandler({ trustProxy: config.trustProxy });

const server = http.createServer(async (req, res) => {
  // `new URL` throws on request targets and Host headers that the HTTP
  // parser accepts but the URL parser does not — `GET //`, `GET ///`, a
  // Host with a space or an out-of-range port. Thrown here, in a request
  // listener, it takes the whole process down and every live signaling
  // socket with it. One request from any scanner on the internet ends
  // every session on the server.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...hub.stats(), turn: turnConfigured() }));
    return;
  }

  try {
    if (await serveInstall(req, res, url)) return;
    if (await serveStatic(req, res, url)) return;
  } catch (err) {
    console.error('[http] static error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end('Internal error');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

/* ------------------------------------------------------------------ *
 * WebSocket signaling
 * ------------------------------------------------------------------ */

const wss = new WebSocketServer({
  server,
  path: '/signal',
  maxPayload: 256 * 1024,
  verifyClient({ origin, req }, done) {
    // Host agents send no Origin header; browsers always do. An empty
    // allowlist means "same origin only", which is the safe default for
    // a single-domain deployment.
    if (!origin) return done(true);
    if (config.allowedOrigins.length === 0) {
      const host = req.headers.host;
      try {
        return done(new URL(origin).host === host);
      } catch {
        return done(false);
      }
    }
    return done(config.allowedOrigins.includes(origin));
  },
});

wss.on('connection', (socket, req) => {
  const peer = new Peer(socket, addressOf(req));
  // The heartbeat below reads liveness back off the socket.
  socket._deskyPeer = peer;
  hub.attach(peer);
});

/**
 * Thin wrapper turning a raw WebSocket into something the hub can talk
 * to: parsed JSON in, serialized JSON out, plus liveness tracking.
 */
class Peer extends EventEmitter {
  constructor(socket, address) {
    super();
    this.id = newId(8);
    this.socket = socket;
    this.address = address;
    this.role = null;
    this.code = null;
    this.name = null;
    this.alive = true;

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        this.send({ t: MSG.ERROR, message: 'Malformed JSON' });
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      this.emit('message', msg);
    });

    socket.on('pong', () => { this.alive = true; });
    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => {
      console.warn('[ws] peer %s error: %s', this.id, err.message);
    });
  }

  send(msg) {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  close() {
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

/**
 * A remote-support session can legitimately sit idle for hours while
 * someone watches a long install, so idle timeouts are out. Instead the
 * server pings and only drops peers that stop answering — which detects
 * a dead network without ever cutting off live work.
 */
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const peer = socket._deskyPeer;
    if (peer && peer.alive === false) {
      socket.terminate();
      continue;
    }
    if (peer) peer.alive = false;
    try { socket.ping(); } catch { /* socket closing */ }
  }
}, config.heartbeatMs);
heartbeat.unref?.();

/**
 * The client's address, as far as it can be trusted.
 *
 * `X-Forwarded-For` is a chain the client can start writing: a proxy
 * appends the peer it saw, it does not replace what was there. So the
 * first entry is whatever the caller chose to claim, and reading it
 * would hand an attacker a free identity — which matters here because
 * this value keys the rate limiter that is the only wire-level brake on
 * password guessing, and it is shown to the client as "From" in the
 * consent dialog.
 *
 * The entry this deployment's own proxy appended is the last one, so
 * that is the one taken.
 */
function addressOf(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      if (chain.length > 0) return chain[chain.length - 1];
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

server.listen(config.port, config.host, () => {
  const where = config.publicUrl ?? `http://localhost:${config.port}`;
  console.log('');
  console.log('  Desky signaling server');
  console.log('  ─────────────────────────');
  console.log(`  Operator console : ${where}`);
  console.log(`  Signaling socket : ${where.replace(/^http/, 'ws')}/signal`);
  console.log(`  TURN             : ${turnConfigured() ? config.turnHost : 'not configured (STUN only)'}`);
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[server] got ${signal}, shutting down`);
  clearInterval(heartbeat);
  hub.shutdown();
  for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
