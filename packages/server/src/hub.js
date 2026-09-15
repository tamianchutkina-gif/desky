import { randomBytes } from 'node:crypto';

import { config, newId } from './config.js';
import { DeviceStore } from './store.js';
import { RateLimiter } from './ratelimit.js';
import { iceServersFor } from './turn.js';
import { MSG, REJECT, PROTOCOL_VERSION } from '../../../shared/protocol.js';

/** A proof is HMAC-SHA-256 as lowercase hex — anything else is not worth relaying. */
const PROOF_SHAPE = /^[0-9a-f]{64}$/;

/**
 * The signaling hub.
 *
 * What this server does: introduces two peers, relays their SDP and ICE
 * candidates, and enforces coarse rate limits.
 *
 * What it deliberately does not do: see the screen, see the keystrokes,
 * or learn the session password. Media flows peer-to-peer under
 * DTLS-SRTP, and the password is verified on the client's own machine.
 * Compromising this server gets an attacker the ability to break
 * sessions, not to watch or start them.
 */

/** How long an unanswered challenge stays usable. */
const CHALLENGE_WINDOW_MS = 30_000;

export class Hub {
  /** code -> host socket wrapper */
  #hosts = new Map();
  /** sessionId -> session */
  #sessions = new Map();
  /** code -> { failures, lockedUntil } */
  #penalties = new Map();

  #store = new DeviceStore();
  #limiter = new RateLimiter(config.attemptsPerMinute);
  #registrations = new RateLimiter(config.registrationsPerHour, 3_600_000);

  stats() {
    return {
      hostsOnline: this.#hosts.size,
      activeSessions: [...this.#sessions.values()].filter((s) => s.state === 'active').length,
      pendingSessions: [...this.#sessions.values()].filter((s) => s.state !== 'active').length,
    };
  }

  /* ---------------------------------------------------------------- *
   * Connection lifecycle
   * ---------------------------------------------------------------- */

  attach(peer) {
    peer.on('message', (msg) => {
      try {
        this.#dispatch(peer, msg);
      } catch (err) {
        console.error('[hub] error handling %s from %s:', msg?.t, peer.id, err);
        peer.send({ t: MSG.ERROR, message: 'Internal server error' });
      }
    });

    peer.on('close', () => this.#onClose(peer));
  }

  #dispatch(peer, msg) {
    switch (msg.t) {
      case MSG.HOST_REGISTER: return this.#onHostRegister(peer, msg);
      case MSG.HOST_DECISION: return this.#onHostDecision(peer, msg);
      case MSG.HOST_END: return this.#onHostEnd(peer, msg);
      case MSG.OP_LOOKUP: return this.#onLookup(peer, msg);
      case MSG.OP_AUTH: return this.#onAuth(peer, msg);
      case MSG.OP_END: return this.#onOperatorEnd(peer, msg);
      case MSG.SIGNAL: return this.#onSignal(peer, msg);
      // Echo a timestamp, not whatever arrived. `ts` was reflected
      // verbatim, so a peer could bounce a quarter-megabyte string off
      // the server on every ping and never read the replies — filling an
      // unbounded send queue in this process rather than their own.
      case MSG.PING:
        return peer.send({ t: MSG.PONG, ts: typeof msg.ts === 'number' ? msg.ts : Date.now() });
      default:
        return peer.send({ t: MSG.ERROR, message: 'Unknown message type' });
    }
  }

  #onClose(peer) {
    // Keyed off the code rather than the role: a peer that registered as
    // a host and later sent op:lookup would otherwise be left in #hosts
    // forever, answering lookups for a socket that is gone.
    if (peer.code && this.#hosts.get(peer.code) === peer) {
      this.#hosts.delete(peer.code);
      console.log('[hub] host %s offline', peer.code);
    }

    for (const session of [...this.#sessions.values()]) {
      if (session.host !== peer && session.operator !== peer) continue;

      const hostLeft = session.host === peer;
      const reason = hostLeft ? 'host_disconnected' : 'operator_disconnected';

      // Tell the survivor. Every deliberate end path does this; without
      // it here, an operator whose laptop lost power leaves the client
      // waiting on an ICE timeout with the session still shown as live.
      if (hostLeft) {
        session.operator?.send({ t: MSG.OP_PEER_GONE, sessionId: session.id, reason });
      } else {
        session.host?.send({ t: MSG.HOST_PEER_GONE, sessionId: session.id, reason });
      }

      this.#closeSession(session, reason);
    }
  }

  /* ---------------------------------------------------------------- *
   * Host side
   * ---------------------------------------------------------------- */

  #onHostRegister(peer, msg) {
    if (msg.protocol !== PROTOCOL_VERSION) {
      peer.send({ t: MSG.ERROR, reason: REJECT.VERSION, message: 'Update the agent to the current version' });
      return;
    }

    // Reclaiming an existing id with a valid token is free; minting a
    // brand new one is metered, because every mint is a permanent row in
    // the registry and a 9-digit code burned forever.
    //
    // The token has to actually match. Testing that one was merely
    // *present* meant any string at all counted as a reclaim, so both
    // gates below were skipped for what claim() then went on to treat as
    // a fresh mint — an unmetered way to fill the registry from a single
    // socket, one synchronous whole-file rewrite per row.
    const returning = this.#store.verify(msg.code, msg.token);
    if (!returning && !this.#registrations.take(peer.address)) {
      peer.send({ t: MSG.ERROR, reason: REJECT.RATE_LIMITED, message: 'Too many new devices from this address' });
      return;
    }

    if (!returning && this.#store.size >= config.maxDevices) {
      peer.send({ t: MSG.ERROR, message: 'The device registry is full' });
      console.warn('[hub] registry hit its limit of %d devices', config.maxDevices);
      return;
    }

    // Rendered on the operator's screen, written to the registry and to
    // the log, so it gets the same treatment as the operator's own name:
    // no control characters, no bidi overrides, and a length that cannot
    // turn one registration into a quarter-megabyte row.
    const hostName = sanitizeName(msg.name, "Client's computer");
    const platform = typeof msg.platform === 'string' ? msg.platform.slice(0, 16) : 'unknown';

    const claim = this.#store.claim({
      code: msg.code,
      token: msg.token,
      name: hostName,
      platform,
    });

    // A second agent presenting the same credentials replaces the first
    // rather than shadowing it, so a crashed-and-restarted agent does
    // not leave its ID unreachable until a timeout expires.
    const previous = this.#hosts.get(claim.code);
    if (previous && previous !== peer) {
      previous.send({
        t: MSG.ERROR,
        reason: REJECT.DISPLACED,
        message: 'Another copy of the agent took over this ID',
      });
      previous.close();
    }

    // A socket that registers more than once used to leave its earlier
    // code in #hosts pointing at itself for ever — #onClose only removes
    // the last one. Those ghosts kept answering lookups, so an operator
    // could be handed a challenge for a machine that was never there and
    // then wait out the whole consent window.
    if (peer.code && peer.code !== claim.code && this.#hosts.get(peer.code) === peer) {
      this.#hosts.delete(peer.code);
    }

    peer.role = 'host';
    peer.code = claim.code;
    peer.name = hostName;
    this.#hosts.set(claim.code, peer);

    peer.send({
      t: MSG.HOST_REGISTERED,
      code: claim.code,
      token: claim.token,
      created: claim.created,
      protocol: PROTOCOL_VERSION,
    });

    console.log('[hub] host %s online (%s)', claim.code, peer.name);
  }

  #onHostDecision(peer, msg) {
    const session = this.#sessions.get(msg.sessionId);
    if (!session || session.host !== peer) return;
    if (session.state !== 'pending') return;

    clearTimeout(session.consentTimer);
    session.consentTimer = null;

    if (!msg.accept) {
      // Pass through what the agent actually said. Collapsing everything
      // into `declined` told the operator that a person had refused them
      // when the agent was merely busy or had timed out — the kind of
      // false factual claim about someone's decision that endedText's
      // comment in shared/protocol.js exists to prevent. An unknown
      // reason from a newer agent still reads as a plain decline.
      const known = new Set([
        REJECT.BAD_PASSWORD, REJECT.BUSY, REJECT.TIMEOUT, REJECT.DECLINED, REJECT.LOCKED,
      ]);
      const reason = known.has(msg.reason) ? msg.reason : REJECT.DECLINED;

      // Only a failed password proof earns a penalty. A person deciding
      // "not now" is a normal answer, not an attack, and must never
      // push their own machine toward lockout.
      if (reason === REJECT.BAD_PASSWORD) this.#penalize(session.code, session.operator?.address);

      session.operator?.send({ t: MSG.OP_REJECTED, sessionId: session.id, reason });
      this.#closeSession(session, reason);
      return;
    }

    this.#clearPenalty(session.code, session.operator?.address);
    session.state = 'active';
    session.startedAt = Date.now();

    session.operator?.send({
      t: MSG.OP_ACCEPTED,
      sessionId: session.id,
      hostName: peer.name,
      iceServers: iceServersFor(`op-${session.id}`),
      displays: msg.displays ?? [],
      canControl: msg.canControl !== false,
    });

    console.log('[hub] session %s active (code %s)', session.id, session.code);
  }

  #onHostEnd(peer, msg) {
    const session = this.#sessions.get(msg.sessionId);
    if (!session || session.host !== peer) return;
    session.operator?.send({ t: MSG.OP_PEER_GONE, sessionId: session.id, reason: msg.reason || 'host_ended' });
    this.#closeSession(session, msg.reason || 'host_ended');
  }

  /* ---------------------------------------------------------------- *
   * Operator side
   * ---------------------------------------------------------------- */

  #onLookup(peer, msg) {
    if (!this.#limiter.take(peer.address)) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.RATE_LIMITED });
      return;
    }

    const code = String(msg.code ?? '').replace(/\D/g, '');
    const host = this.#hosts.get(code);

    if (!host) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.BAD_CODE });
      return;
    }

    if (this.#isLocked(code, peer.address)) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.LOCKED });
      return;
    }

    if (this.#sessionForCode(code)) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.BUSY });
      return;
    }

    // The challenge lives on the asking socket, not in #sessions, and so
    // does not mark the code busy. Only a proof — which needs the
    // password — reserves the machine.
    const challenge = {
      id: newId(12),
      code,
      nonce: randomBytes(24).toString('hex'),
      expiresAt: Date.now() + CHALLENGE_WINDOW_MS,
    };
    peer.challenge = challenge;

    peer.send({
      t: MSG.OP_CHALLENGE,
      sessionId: challenge.id,
      nonce: challenge.nonce,
      hostName: host.name,
    });
  }


  #onAuth(peer, msg) {
    const challenge = peer.challenge;
    if (!challenge || challenge.id !== msg.sessionId || Date.now() > challenge.expiresAt) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.BAD_CODE });
      return;
    }
    peer.challenge = null;

    if (!this.#limiter.take(peer.address)) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.RATE_LIMITED });
      return;
    }

    const host = this.#hosts.get(challenge.code);
    if (!host) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.BAD_CODE });
      return;
    }
    // The proof is relayed untouched, but its shape is checked here so
    // that a request carrying a kilobyte of garbage never reaches the
    // agent — each attempt the agent looks at costs it a key derivation,
    // and that is the client's CPU, not the server's.
    if (!PROOF_SHAPE.test(String(msg.proof ?? ''))) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.BAD_PASSWORD });
      return;
    }
    if (this.#isLocked(challenge.code, peer.address)) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.LOCKED });
      return;
    }
    if (this.#sessionForCode(challenge.code)) {
      peer.send({ t: MSG.OP_REJECTED, reason: REJECT.BUSY });
      return;
    }

    peer.role = 'operator';

    const session = {
      id: challenge.id,
      code: challenge.code,
      host,
      operator: peer,
      state: 'pending',
      nonce: challenge.nonce,
      createdAt: Date.now(),
      consentTimer: null,
      operatorName: sanitizeName(msg.operatorName),
    };
    this.#sessions.set(session.id, session);

    // The proof travels through this server untouched. Only the agent
    // on the client's machine knows the password it is checked against.
    //
    // ICE servers ride along here rather than in the acceptance, because
    // the agent needs them the instant its user says yes — fetching them
    // afterwards would add a round trip to the one moment someone is
    // watching a progress indicator.
    session.host.send({
      t: MSG.HOST_REQUEST,
      sessionId: session.id,
      nonce: session.nonce,
      proof: msg.proof,
      operatorName: session.operatorName,
      operatorAddr: session.operator.address,
      iceServers: iceServersFor(`host-${session.id}`),
      protocol: PROTOCOL_VERSION,
    });

    peer.send({ t: MSG.OP_PENDING, sessionId: session.id, hostName: session.host.name });

    session.consentTimer = setTimeout(() => {
      if (session.state !== 'pending') return;
      session.operator?.send({ t: MSG.OP_REJECTED, sessionId: session.id, reason: REJECT.TIMEOUT });
      session.host?.send({ t: MSG.HOST_PEER_GONE, sessionId: session.id, reason: REJECT.TIMEOUT });
      this.#closeSession(session, REJECT.TIMEOUT);
    }, config.consentTimeoutMs);
    session.consentTimer.unref?.();
  }

  #onOperatorEnd(peer, msg) {
    const session = this.#sessions.get(msg.sessionId);
    if (!session || session.operator !== peer) return;
    session.host?.send({ t: MSG.HOST_PEER_GONE, sessionId: session.id, reason: 'operator_ended' });
    this.#closeSession(session, 'operator_ended');
  }

  /* ---------------------------------------------------------------- *
   * Relay
   * ---------------------------------------------------------------- */

  #onSignal(peer, msg) {
    const session = this.#sessions.get(msg.sessionId);
    if (!session || session.state !== 'active') return;

    const target = session.host === peer ? session.operator
      : session.operator === peer ? session.host
        : null;
    if (!target) return;

    target.send({ t: MSG.SIGNAL, sessionId: session.id, payload: msg.payload });
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #sessionForCode(code) {
    for (const session of this.#sessions.values()) {
      if (session.code === code && session.state !== 'closed') return session;
    }
    return null;
  }

  #closeSession(session, reason) {
    if (session.state === 'closed') return;
    session.state = 'closed';
    clearTimeout(session.consentTimer);
    this.#sessions.delete(session.id);

    const duration = session.startedAt ? Date.now() - session.startedAt : 0;
    console.log('[hub] session %s closed (%s)%s', session.id, reason,
      duration ? ` after ${Math.round(duration / 1000)}s` : '');
  }

  /**
   * Lockouts are keyed by who is asking as well as which machine.
   *
   * Keyed by code alone, this was a way for any stranger who knew a
   * nine-digit number to keep that machine permanently unreachable: a
   * wrong proof is refused by the agent before any human sees it, so a
   * handful of messages locked out the real operator, silently, and
   * could be repeated for ever. The client saw nothing and the operator
   * was told the password was wrong.
   *
   * Guessing is still braked — the agent rotates its password after
   * three bad proofs, which is the defence that actually matters — but
   * the brake now costs the guesser their own access, not the client's.
   */
  #penaltyKey(code, address) {
    return `${code}|${address ?? 'unknown'}`;
  }

  #penalize(code, address) {
    const key = this.#penaltyKey(code, address);
    const entry = this.#penalties.get(key) ?? { failures: 0, lockedUntil: 0, updatedAt: 0 };
    entry.failures += 1;
    entry.updatedAt = Date.now();
    if (entry.failures >= config.maxAuthFailures) {
      entry.lockedUntil = Date.now() + config.authLockoutMs;
      entry.failures = 0;
      console.warn('[hub] %s locked out of code %s for %d minutes after repeated bad passwords',
        address ?? 'unknown', code, Math.round(config.authLockoutMs / 60000));
    }
    this.#penalties.set(key, entry);
  }

  #clearPenalty(code, address) {
    this.#penalties.delete(this.#penaltyKey(code, address));
  }

  #isLocked(code, address) {
    const key = this.#penaltyKey(code, address);
    const entry = this.#penalties.get(key);
    if (!entry) return false;

    const now = Date.now();
    if (entry.lockedUntil && now < entry.lockedUntil) return true;

    // Drop the row when its lockout has run out, or when a partial run of
    // failures has gone quiet for a whole lockout window. Dropping it
    // while `failures` was still climbing is what erased the counter
    // between every pair of guesses: the threshold was never reached, so
    // REJECT.LOCKED was a state this class could not enter. The same
    // shape as the Identity#verify bug the 2026-08-27 audit fixed.
    if (entry.lockedUntil || now - entry.updatedAt > config.authFailureWindowMs) {
      this.#penalties.delete(key);
    }
    return false;
  }

  shutdown() {
    this.#store.flush();
  }
}

/**
 * The operator's name is rendered into a consent dialog on someone
 * else's machine, so strip everything that could forge extra text
 * there: control characters, line breaks, and bidi overrides.
 */
function sanitizeName(name, fallback = 'Operator') {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, '')
    .trim();
  return cleaned.slice(0, 48) || fallback;
}
