import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { MSG, REJECT, PROTOCOL_VERSION, computeProof, proofsEqual } from '../shared/protocol.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Exercises the real signaling server end to end.
 *
 * Two sockets stand in for the client's agent and the operator's
 * console and speak the actual protocol, so this covers the parts that
 * only break when the pieces meet: the challenge-response, the fact
 * that the server never learns the password, consent, relay, and the
 * refusals.
 */

const PORT = 8000 + Math.floor(Math.random() * 900);
const PASSWORD = 'AB3D9KQM';

let server;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-test-'));

  server = spawn(process.execPath, [path.join(ROOT, 'packages/server/src/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      CONSENT_TIMEOUT_MS: '3000',
      // Every peer in this suite is 127.0.0.1 and shares one budget, so
      // the production limits would throttle the tests rather than the
      // behaviour under test. The limits get their own test below.
      ATTEMPTS_PER_MINUTE: '10000',
      REGISTRATIONS_PER_HOUR: '10000',
      // The lockout gets its own tests below, and the production
      // five-strike, five-minute setting would make them slow. The
      // failure window stays long on purpose: each guess costs a real
      // PBKDF2 derivation in this process, and on a slow runner three of
      // them take longer than a two second window — the counter forgot
      // the first guess before the third arrived, and the lockout test
      // flickered.
      MAX_AUTH_FAILURES: '3',
      AUTH_LOCKOUT_MS: '2000',
      AUTH_FAILURE_WINDOW_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServer();
});

after(() => {
  server?.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function waitForServer() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await delay(100);
  }
  throw new Error('the server did not come up');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a request `fetch` will not: a malformed target or Host header.
 * Resolves with the status code, or 0 if the server answered nothing.
 */
function rawRequest(raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, '127.0.0.1');
    let received = '';

    socket.setTimeout(5000, () => { socket.destroy(); resolve(0); });
    socket.on('connect', () => socket.write(raw));
    socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => {
      const match = received.match(/^HTTP\/1\.[01] (\d{3})/);
      resolve(match ? Number(match[1]) : 0);
    });
  });
}

/** A socket that queues messages so tests can await them in order. */
class Peer {
  #queue = [];
  #waiters = [];

  constructor(socket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      const waiter = this.#waiters.shift();
      if (waiter) waiter(msg);
      else this.#queue.push(msg);
    });
  }

  static async open() {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/signal`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new Peer(socket);
  }

  send(msg) {
    this.socket.send(JSON.stringify(msg));
  }

  next(timeoutMs = 4000) {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(wrapped);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error('no message arrived within the timeout'));
      }, timeoutMs);

      const wrapped = (msg) => { clearTimeout(timer); resolve(msg); };
      this.#waiters.push(wrapped);
    });
  }

  /** Skips ahead to the next message of a given type. */
  async until(type, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await this.next(Math.max(50, deadline - Date.now()));
      if (msg.t === type) return msg;
      if (Date.now() > deadline) throw new Error(`never received ${type}`);
    }
  }

  close() {
    try { this.socket.close(); } catch { /* already closing */ }
  }
}

async function registerHost(existing) {
  const host = await Peer.open();
  host.send({
    t: MSG.HOST_REGISTER,
    protocol: PROTOCOL_VERSION,
    code: existing?.code,
    token: existing?.token,
    name: "Irina's computer",
    platform: 'darwin',
  });
  const registered = await host.until(MSG.HOST_REGISTERED);
  return { host, code: registered.code, token: registered.token, created: registered.created };
}

/** Drives the operator side up to the point the client must decide. */
async function requestAccess(code, password, operatorName = 'Tami') {
  const op = await Peer.open();
  op.send({ t: MSG.OP_LOOKUP, code });

  const first = await op.next();
  if (first.t === MSG.OP_REJECTED) return { op, rejected: first };

  assert.equal(first.t, MSG.OP_CHALLENGE);
  const proof = await computeProof(password, first.nonce, code, first.sessionId);
  op.send({ t: MSG.OP_AUTH, sessionId: first.sessionId, proof, operatorName });

  return { op, challenge: first };
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

test('a new agent receives a nine-digit id and a token', async () => {
  const { host, code, token, created } = await registerHost();
  assert.match(code, /^\d{9}$/);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.equal(created, true);
  host.close();
});

test('an agent presenting its token keeps the same id', async () => {
  const first = await registerHost();
  first.host.close();
  await delay(100);

  const second = await registerHost({ code: first.code, token: first.token });
  assert.equal(second.code, first.code, 'id must survive a restart');
  assert.equal(second.created, false);
  second.host.close();
});

test('a forged token yields a different id rather than hijacking one', async () => {
  const real = await registerHost();
  real.host.close();
  await delay(100);

  const forged = await registerHost({ code: real.code, token: 'f'.repeat(64) });
  assert.notEqual(forged.code, real.code);
  forged.host.close();
});

/* ------------------------------------------------------------------ *
 * Connecting
 * ------------------------------------------------------------------ */

test('an agent on an older protocol is told to update, not that its password is wrong', async () => {
  // The version is what a client on a previous build actually meets
  // after the wire changes. Refusing it by name is the difference
  // between "reinstall" and an evening spent re-reading a password
  // that was correct all along.
  const peer = await Peer.open();
  peer.send({
    t: MSG.HOST_REGISTER,
    protocol: PROTOCOL_VERSION - 1,
    name: 'An older build',
    platform: 'darwin',
  });
  const reply = await peer.next();
  assert.equal(reply.t, MSG.ERROR);
  assert.equal(reply.reason, REJECT.VERSION);
  peer.close();
});

test('an unknown id is refused before any password is asked for', async () => {
  const { op, rejected } = await requestAccess('000000001', PASSWORD);
  assert.equal(rejected.t, MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BAD_CODE);
  op.close();
});

test('the server relays a proof it cannot itself verify', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  assert.equal(request.operatorName, 'Tami');
  assert.ok(request.nonce);
  assert.ok(request.proof);

  // The decisive property: only the agent can tell whether this proof
  // is right, and it can, because it holds the password.
  const expected = await computeProof(PASSWORD, request.nonce, code, request.sessionId);
  assert.ok(proofsEqual(request.proof, expected));

  const wrong = await computeProof('ZZZZZZ', request.nonce, code, request.sessionId);
  assert.ok(!proofsEqual(request.proof, wrong));

  host.close();
  op.close();
});

test('ice servers reach both sides so neither waits on a round trip', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  assert.ok(Array.isArray(request.iceServers));
  assert.ok(request.iceServers.length > 0);

  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  const accepted = await op.until(MSG.OP_ACCEPTED);
  assert.ok(Array.isArray(accepted.iceServers));
  assert.ok(accepted.iceServers.length > 0);

  host.close();
  op.close();
});

test('nothing reaches the operator until a human accepts', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const pending = await op.until(MSG.OP_PENDING);
  assert.equal(typeof pending.sessionId, 'string');

  const request = await host.until(MSG.HOST_REQUEST);

  // Relay is refused while the session is merely pending.
  op.send({ t: MSG.SIGNAL, sessionId: request.sessionId, payload: { type: 'offer', sdp: 'premature' } });
  await assert.rejects(() => host.until(MSG.SIGNAL, 600));

  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  await op.until(MSG.OP_ACCEPTED);

  host.close();
  op.close();
});

test('a declined request tells the operator so plainly', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({
    t: MSG.HOST_DECISION,
    sessionId: request.sessionId,
    accept: false,
    reason: REJECT.DECLINED,
  });

  const rejected = await op.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.DECLINED);

  host.close();
  op.close();
});

test('a wrong password is reported as a wrong password', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, 'WRONG1');

  const request = await host.until(MSG.HOST_REQUEST);
  const expected = await computeProof(PASSWORD, request.nonce, code, request.sessionId);
  assert.ok(!proofsEqual(request.proof, expected), 'the wrong password must not verify');

  host.send({
    t: MSG.HOST_DECISION,
    sessionId: request.sessionId,
    accept: false,
    reason: REJECT.BAD_PASSWORD,
  });

  const rejected = await op.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BAD_PASSWORD);

  host.close();
  op.close();
});

/* ------------------------------------------------------------------ *
 * Relay
 * ------------------------------------------------------------------ */

test('sdp and candidates relay in both directions once active', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  await op.until(MSG.OP_ACCEPTED);

  const sessionId = request.sessionId;

  host.send({ t: MSG.SIGNAL, sessionId, payload: { type: 'offer', sdp: 'v=0 host' } });
  const toOperator = await op.until(MSG.SIGNAL);
  assert.equal(toOperator.payload.sdp, 'v=0 host');

  op.send({ t: MSG.SIGNAL, sessionId, payload: { type: 'answer', sdp: 'v=0 operator' } });
  const toHost = await host.until(MSG.SIGNAL);
  assert.equal(toHost.payload.sdp, 'v=0 operator');

  host.close();
  op.close();
});

test('a second operator is refused while a session is running', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  await op.until(MSG.OP_ACCEPTED);

  const intruder = await Peer.open();
  intruder.send({ t: MSG.OP_LOOKUP, code });
  const rejected = await intruder.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BUSY);

  intruder.close();
  host.close();
  op.close();
});

test('the operator learns when the agent disappears', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  await op.until(MSG.OP_ACCEPTED);

  host.send({ t: MSG.HOST_END, sessionId: request.sessionId, reason: 'client_ended' });
  const gone = await op.until(MSG.OP_PEER_GONE);
  assert.equal(gone.reason, 'client_ended');

  host.close();
  op.close();
});

test('an unanswered request expires instead of hanging forever', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  await host.until(MSG.HOST_REQUEST);
  await op.until(MSG.OP_PENDING);

  // The server was started with a three second consent window.
  const rejected = await op.until(MSG.OP_REJECTED, 6000);
  assert.equal(rejected.reason, REJECT.TIMEOUT);

  // And the machine is reachable again afterwards.
  const retry = await requestAccess(code, PASSWORD);
  assert.ok(!retry.rejected, 'an expired request must not leave the id locked');

  retry.op.close();
  host.close();
  op.close();
});

test('malformed input does not take the server down', async () => {
  const peer = await Peer.open();
  peer.socket.send('this is not json');
  const error = await peer.until(MSG.ERROR);
  assert.ok(error.message);

  peer.send({ t: 'nonsense:type' });
  await peer.until(MSG.ERROR);

  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.ok(res.ok, 'server still serving');

  peer.close();
});

test('a request target the URL parser rejects does not take the server down', async () => {
  // `new URL` throws on targets the HTTP parser is happy to deliver, and
  // it used to be called outside any try/catch in a request listener —
  // so a single `GET //`, which any scanner on the internet sends
  // unprompted, killed the process and every live session on it.
  for (const target of ['//', '///', '//x', '/%']) {
    const status = await rawRequest(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    assert.ok(status > 0, `${target} got no response at all`);

    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.ok(res.ok, `server died on ${target}`);
  }
});

test('a Host header the URL parser rejects does not take the server down', async () => {
  for (const host of ['a b c', ']', '127.0.0.1:99999', '[::1]:99999']) {
    const status = await rawRequest(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.ok(status > 0, `Host: ${host} got no response at all`);

    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.ok(res.ok, `server died on Host: ${host}`);
  }
});

test('a bogus token cannot mint device ids for free', async () => {
  // The registration gates keyed off a token being *present* rather than
  // correct, so presenting any string at all counted as reclaiming an
  // existing id — and skipped both the rate limit and the registry cap
  // for what was in fact a fresh mint.
  const first = await registerHost();

  const peer = await Peer.open();
  let minted = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    peer.send({
      t: MSG.HOST_REGISTER,
      protocol: PROTOCOL_VERSION,
      code: first.code,
      token: 'not-the-real-token',
      name: 'Impostor',
      platform: 'darwin',
    });
    const reply = await peer.next();
    if (reply.t === MSG.HOST_REGISTERED) {
      minted += 1;
      assert.notEqual(reply.code, first.code, 'a wrong token must never hand over an existing id');
    }
  }

  // Minting is allowed — it is what an honest first run does — but it
  // must go through the meter rather than around it.
  assert.ok(minted > 0, 'the socket should still be able to register as a new device');

  peer.close();
  first.host.close();
});

/* ------------------------------------------------------------------ *
 * Denial of service
 * ------------------------------------------------------------------ */

test('an unauthenticated lookup does not reserve the machine', async () => {
  // Reserving the code at lookup would let anyone who knows a nine-digit
  // id hold a machine unreachable indefinitely, without ever presenting
  // a password.
  const { host, code } = await registerHost();

  const squatter = await Peer.open();
  squatter.send({ t: MSG.OP_LOOKUP, code });
  const challenge = await squatter.until(MSG.OP_CHALLENGE);
  assert.ok(challenge.nonce, 'squatter got a challenge');

  // The real operator must still get through.
  const legit = await requestAccess(code, PASSWORD);
  assert.ok(!legit.rejected, 'an unanswered lookup must not mark the code busy');
  await host.until(MSG.HOST_REQUEST);

  squatter.close();
  legit.op.close();
  host.close();
});

test('a proven operator does reserve the machine', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);
  await host.until(MSG.HOST_REQUEST);

  const second = await Peer.open();
  second.send({ t: MSG.OP_LOOKUP, code });
  const rejected = await second.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BUSY);

  second.close();
  op.close();
  host.close();
});

test('auth on a challenge that was never issued is refused', async () => {
  const { host } = await registerHost();

  const forger = await Peer.open();
  forger.send({ t: MSG.OP_AUTH, sessionId: 'made-up', proof: 'x'.repeat(64), operatorName: 'Someone' });
  const rejected = await forger.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BAD_CODE);

  // And the agent was never bothered.
  await assert.rejects(() => host.until(MSG.HOST_REQUEST, 500));

  forger.close();
  host.close();
});

/* ------------------------------------------------------------------ *
 * Abrupt disconnects
 * ------------------------------------------------------------------ */

test('the agent is told when the operator vanishes without warning', async () => {
  // The explicit end paths always notified. A socket that simply dies —
  // an operator's laptop losing power — used to notify nobody, leaving
  // the client's machine to wait out an ICE timeout with the session
  // still shown as live and a modifier possibly still held down.
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  await op.until(MSG.OP_ACCEPTED);

  op.socket.terminate();

  const gone = await host.until(MSG.HOST_PEER_GONE);
  assert.equal(gone.sessionId, request.sessionId);
  assert.equal(gone.reason, 'operator_disconnected');

  host.close();
});

test('the operator is told when the agent vanishes without warning', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({ t: MSG.HOST_DECISION, sessionId: request.sessionId, accept: true, displays: [] });
  await op.until(MSG.OP_ACCEPTED);

  host.socket.terminate();

  const gone = await op.until(MSG.OP_PEER_GONE);
  assert.equal(gone.reason, 'host_disconnected');

  op.close();
});

test('a host that later looks up a code is still cleaned out of the registry', async () => {
  // peer.role used to be overwritten by op:lookup, so the cleanup on
  // close skipped this socket and left a dead entry answering lookups.
  const first = await registerHost();
  first.host.send({ t: MSG.OP_LOOKUP, code: first.code });
  await first.host.until(MSG.OP_CHALLENGE);
  first.host.close();
  await delay(200);

  const seeker = await Peer.open();
  seeker.send({ t: MSG.OP_LOOKUP, code: first.code });
  const rejected = await seeker.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BAD_CODE, 'a closed host must not stay online');

  seeker.close();
});

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

test('minting new device ids is metered per address', async () => {
  // Registration is unauthenticated by design — an agent has no
  // credential on first run — so the only thing standing between a
  // script and an unbounded registry is this limit.
  const limitedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-rl-'));
  const limited = spawn(process.execPath, [path.join(ROOT, 'packages/server/src/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT + 1),
      DATA_DIR: limitedDir,
      REGISTRATIONS_PER_HOUR: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // The other test files run at the same time and spend their seconds
    // in PBKDF2, so a second server can take well over the six seconds
    // this used to allow just to start. Wait as long as the main one.
    let up = false;
    for (let attempt = 0; attempt < 300 && !up; attempt += 1) {
      try {
        up = (await fetch(`http://127.0.0.1:${PORT + 1}/healthz`)).ok;
      } catch { /* not up yet */ }
      if (!up) await delay(100);
    }
    assert.ok(up, 'the rate-limited server never came up');

    const open = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT + 1}/signal`);
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return new Peer(socket);
    };

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      const peer = await open();
      peer.send({ t: MSG.HOST_REGISTER, protocol: PROTOCOL_VERSION, name: `Machine ${i}`, platform: 'darwin' });
      outcomes.push((await peer.next()).t);
      peer.close();
    }

    assert.deepEqual(outcomes.slice(0, 3), Array(3).fill(MSG.HOST_REGISTERED));
    assert.deepEqual(outcomes.slice(3), Array(2).fill(MSG.ERROR), 'excess mints refused');
  } finally {
    limited.kill('SIGKILL');
    fs.rmSync(limitedDir, { recursive: true, force: true });
  }
});

test('an agent with a valid token is never throttled', async () => {
  // A client whose machine reboots repeatedly must always get back
  // online; only minting a brand new id is metered.
  const first = await registerHost();
  first.host.close();
  await delay(100);

  for (let i = 0; i < 6; i += 1) {
    const again = await registerHost({ code: first.code, token: first.token });
    assert.equal(again.code, first.code);
    assert.equal(again.created, false);
    again.host.close();
    await delay(60);
  }
});

test('a displaced agent is told why, so two copies do not fight', async () => {
  // Without a reason code the displaced agent just reconnects and takes
  // the ID back, which displaces the new one, forever. The tag is what
  // lets it stand down instead.
  const first = await registerHost();
  const second = await registerHost({ code: first.code, token: first.token });
  assert.equal(second.code, first.code);

  const error = await first.host.until(MSG.ERROR);
  assert.equal(error.reason, REJECT.DISPLACED);
  assert.ok(error.message);

  first.host.close();
  second.host.close();
});

/* ------------------------------------------------------------------ *
 * The brake on guessing
 * ------------------------------------------------------------------ */

/** Burns one wrong-password attempt against `code` and closes the socket. */
async function burnAttempt(host, code) {
  const { op, rejected } = await requestAccess(code, 'WRONG1');
  assert.ok(!rejected, 'a guess must reach the client to be counted');

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({
    t: MSG.HOST_DECISION,
    sessionId: request.sessionId,
    accept: false,
    reason: REJECT.BAD_PASSWORD,
  });
  await op.until(MSG.OP_REJECTED);
  op.close();
}

test('repeated wrong passwords lock the guesser out of that id', async () => {
  const { host, code } = await registerHost();

  // The server was started with a three-strike limit.
  await burnAttempt(host, code);
  await burnAttempt(host, code);
  await burnAttempt(host, code);

  const fourth = await requestAccess(code, PASSWORD);
  assert.equal(fourth.rejected?.reason, REJECT.LOCKED,
    'the counter has to survive between attempts, or the brake never engages');

  fourth.op.close();
  host.close();
});

test('the lockout expires rather than banning an address forever', async () => {
  const { host, code } = await registerHost();

  await burnAttempt(host, code);
  await burnAttempt(host, code);
  await burnAttempt(host, code);

  // The server was started with a two second lockout.
  await delay(2400);

  const later = await requestAccess(code, PASSWORD);
  assert.ok(!later.rejected, 'a lockout that never lifts is a permanent ban');

  later.op.close();
  host.close();
});

test('a person deciding not now never pushes their own machine toward a lockout', async () => {
  const { host, code } = await registerHost();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { op } = await requestAccess(code, PASSWORD);
    const request = await host.until(MSG.HOST_REQUEST);
    host.send({
      t: MSG.HOST_DECISION,
      sessionId: request.sessionId,
      accept: false,
      reason: REJECT.DECLINED,
    });
    await op.until(MSG.OP_REJECTED);
    op.close();
  }

  const again = await requestAccess(code, PASSWORD);
  assert.ok(!again.rejected, 'declining is a normal answer, not an attack');

  again.op.close();
  host.close();
});

test('a busy agent is not reported as a person who declined', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({
    t: MSG.HOST_DECISION,
    sessionId: request.sessionId,
    accept: false,
    reason: REJECT.BUSY,
  });

  const rejected = await op.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.BUSY,
    'telling the operator a person refused them, when nobody did, is a false claim about that person');

  op.close();
  host.close();
});

test('an unknown refusal reason is still shown as a plain decline', async () => {
  const { host, code } = await registerHost();
  const { op } = await requestAccess(code, PASSWORD);

  const request = await host.until(MSG.HOST_REQUEST);
  host.send({
    t: MSG.HOST_DECISION,
    sessionId: request.sessionId,
    accept: false,
    reason: 'something-a-future-agent-invented',
  });

  const rejected = await op.until(MSG.OP_REJECTED);
  assert.equal(rejected.reason, REJECT.DECLINED);

  op.close();
  host.close();
});
