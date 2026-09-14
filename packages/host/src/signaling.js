import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { MSG } from '../shared/protocol.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

/**
 * The agent's connection to the rendezvous server.
 *
 * Reconnects on its own, indefinitely, with backoff. A client's machine
 * sleeps, changes networks, and loses wifi; if the agent stops trying
 * after a few attempts, the client's ID silently goes dark and the next
 * support call starts with "it says offline". So the only thing that
 * stops the loop is the user closing the agent.
 */
export class SignalingClient extends EventEmitter {
  #url;
  #socket = null;
  #reconnectTimer = null;
  #attempt = 0;
  #closed = false;
  #heartbeat = null;

  /** Pings sent since the last sign of life from the server. */
  #awaitingPong = 0;

  constructor(url) {
    super();
    this.#url = url;
  }

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  get url() {
    return this.#url;
  }

  setUrl(url) {
    if (url === this.#url) return;
    this.#url = url;
    this.#attempt = 0;
    if (this.#socket) {
      try { this.#socket.close(); } catch { /* already closing */ }
    } else if (!this.#closed) {
      this.connect();
    }
  }

  connect() {
    if (this.#closed) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;

    this.emit('status', 'connecting');

    let socket;
    try {
      socket = new WebSocket(this.#url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this.emit('status', 'offline', err.message);
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;

    socket.on('open', () => {
      this.#attempt = 0;
      this.emit('status', 'connected');
      this.emit('open');
      this.#startHeartbeat();
    });

    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      // Anything at all from the server proves the path is alive, so the
      // pong counter resets on every message rather than only on PONG.
      this.#awaitingPong = 0;
      if (msg.t === MSG.PONG) return;

      this.emit('message', msg);
    });

    // ws answers protocol-level pings by itself; this is the other half
    // of the same liveness signal.
    socket.on('ping', () => { this.#awaitingPong = 0; });
    socket.on('pong', () => { this.#awaitingPong = 0; });

    socket.on('close', () => {
      this.#stopHeartbeat();
      if (this.#socket === socket) this.#socket = null;
      this.emit('status', 'offline');
      this.#scheduleReconnect();
    });

    socket.on('error', (err) => {
      this.emit('status', 'offline', err.message);
    });
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer) return;

    // Backs off to half a minute and stays there. Fast enough that a
    // brief network blip is invisible, slow enough not to hammer a
    // server that is genuinely down.
    this.#attempt += 1;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt, 5));
    const delay = base * (0.75 + Math.random() * 0.5);

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  /**
   * Pings, and acts on the silence.
   *
   * Sending a ping and never checking for the reply is not a heartbeat.
   * On a half-open connection — a laptop waking from sleep, a network
   * that changed underneath it — the socket stays `OPEN`, so `close`
   * never fires, the reconnect loop never runs, and the panel says
   * "Ready to connect" for a machine the server can no longer reach.
   * That is exactly the "it says offline" call this class exists to
   * prevent, arriving from the other direction.
   *
   * Two missed replies is the threshold: one covers an ordinary lost
   * packet, two means the path is gone. The server pings on its own
   * schedule too, and its pongs count as life either way.
   */
  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#awaitingPong = 0;
    this.#heartbeat = setInterval(() => {
      if (!this.connected) return;

      if (this.#awaitingPong >= 2) {
        this.emit('status', 'offline', 'the server stopped answering');
        // terminate, not close: a half-open socket will not complete a
        // closing handshake, and close() would wait for one for ever.
        try { this.#socket?.terminate(); } catch { /* already gone */ }
        return;
      }

      this.#awaitingPong += 1;
      this.send({ t: MSG.PING, ts: Date.now() });
    }, 25_000);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#awaitingPong = 0;
  }

  send(msg) {
    if (!this.connected) return false;
    try {
      this.#socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    try { this.#socket?.close(); } catch { /* already gone */ }
    this.#socket = null;
  }
}
