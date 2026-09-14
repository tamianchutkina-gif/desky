import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';

import {
  PASSWORD_ALPHABET,
  PASSWORD_LENGTH,
  computeProof,
  proofsEqual,
} from '../shared/protocol.js';

/**
 * How long an accepted challenge is remembered. Comfortably longer than
 * the consent window, so a proof cannot be replayed once the request it
 * belonged to has expired.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;

/** Bound on the replay set, so a hostile server cannot grow it forever. */
const MAX_REMEMBERED = 512;

/**
 * Bound on the per-source failure table. A hostile server can invent
 * addresses, so this cannot grow with them.
 */
const MAX_SOURCES = 256;

/**
 * This machine's identity and its session password.
 *
 * The password never leaves this process and is never sent to the
 * server. When someone tries to connect, the server forwards their
 * HMAC proof and this class checks it locally — which is what makes
 * "the client's machine is the authority" true rather than a slogan.
 */
export class Identity {
  #file;
  #state;
  #password;
  #failures = new Map();
  #locks = new Map();
  #used = new Map();

  /**
   * @param {string} [dataDir] Where identity.json lives. Defaults to the
   *   agent's user-data directory. Passing it explicitly is what lets the
   *   tests exercise this class — the most security-critical file in the
   *   agent — without an Electron runtime. It had no tests at all, which
   *   is how a lockout that erased itself on the next line survived.
   */
  constructor(dataDir) {
    const dir = dataDir ?? createRequire(import.meta.url)('electron').app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#file = path.join(dir, 'identity.json');
    this.#state = this.#load();
    this.#password = generatePassword();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      if (typeof parsed.code === 'string' && typeof parsed.token === 'string') {
        return parsed;
      }
    } catch {
      /* first run, or a corrupted file we are about to replace */
    }
    return { code: null, token: null, name: defaultName() };
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
    } catch (err) {
      console.error('[identity] could not save:', err.message);
    }
  }

  get code() { return this.#state.code; }
  get token() { return this.#state.token; }
  get name() { return this.#state.name || defaultName(); }
  get password() { return this.#password; }

  setName(name) {
    const cleaned = String(name ?? '').trim().slice(0, 48);
    if (!cleaned) return;
    this.#state.name = cleaned;
    this.#save();
  }

  /** Records the ID and token the server assigned to this machine. */
  adopt({ code, token }) {
    if (!code || !token) return;
    if (this.#state.code === code && this.#state.token === token) return;
    this.#state.code = code;
    this.#state.token = token;
    this.#save();
  }

  /** Issues a fresh session password, invalidating the previous one. */
  rotatePassword() {
    this.#password = generatePassword();
    this.#failures.clear();
    this.#locks.clear();
    // Proofs were computed against the old password and are now dead,
    // so nothing needs remembering.
    this.#used.clear();
    return this.#password;
  }

  #sweepUsed() {
    const now = Date.now();
    for (const [ticket, expiry] of this.#used) {
      if (now >= expiry) this.#used.delete(ticket);
    }
    // Oldest-first eviction if a burst of valid challenges outruns the TTL.
    while (this.#used.size > MAX_REMEMBERED) {
      this.#used.delete(this.#used.keys().next().value);
    }
  }

  #sweepLocks() {
    const now = Date.now();
    for (const [key, until] of this.#locks) {
      if (now >= until) {
        this.#locks.delete(key);
        this.#failures.delete(key);
      }
    }
    while (this.#failures.size > MAX_SOURCES) {
      this.#failures.delete(this.#failures.keys().next().value);
    }
  }

  /**
   * Whether this particular caller is locked out.
   *
   * The counter is keyed by the address the server says the request came
   * from, not held globally. A global one meant three guesses from any
   * stranger who had once seen the nine-digit id locked the machine for
   * everyone, including the operator the client was on the phone with,
   * and could be repeated every minute for as long as the stranger
   * cared to. The server's own lockout was keyed this way from the
   * start; this one was not.
   */
  lockedFor(source) {
    this.#sweepLocks();
    return this.#locks.has(sourceKey(source));
  }

  /** Whether any caller is locked out, which is what the panel renders. */
  get locked() {
    this.#sweepLocks();
    return this.#locks.size > 0;
  }

  get lockRemainingMs() {
    this.#sweepLocks();
    let longest = 0;
    const now = Date.now();
    for (const until of this.#locks.values()) longest = Math.max(longest, until - now);
    return longest;
  }

  /**
   * Verifies an operator's proof against the current session password.
   *
   * A wrong password rotates it after a few tries rather than merely
   * counting failures, so a guessing attempt is not just slowed down —
   * it is invalidated, and whoever is guessing has to get the new
   * password from the person sitting at the machine.
   *
   * Each accepted challenge is remembered and refused thereafter. Without
   * that, a proof captured from one attempt — a request that timed out
   * while the client was away from the desk, say — stays valid for as
   * long as the password does, and could be replayed to raise the
   * consent dialog again and again.
   */
  async verify({ proof, nonce, sessionId, source }) {
    const key = sourceKey(source);
    if (this.lockedFor(source)) return false;
    if (typeof nonce !== 'string' || nonce.length < 16) return false;

    const ticket = `${nonce}|${sessionId}`;
    this.#sweepUsed();
    if (this.#used.has(ticket)) return false;

    // Claimed before the await, not after. computeProof yields the event
    // loop, so two requests carrying the same nonce delivered in one tick
    // both passed the check above before either recorded it — and
    // single-use nonces are the thing that stops a captured proof being
    // presented twice. A wrong proof burns the nonce too: the server
    // mints a new one for every attempt, so an honest operator is never
    // short of them.
    this.#used.set(ticket, Date.now() + CHALLENGE_TTL_MS);

    const expected = await computeProof(this.#password, nonce, this.#state.code, sessionId);

    if (proofsEqual(proof, expected)) {
      this.#failures.delete(key);
      return true;
    }

    const failures = (this.#failures.get(key) ?? 0) + 1;
    this.#failures.set(key, failures);

    if (failures >= 3) {
      // Order matters. rotatePassword() clears the locks, so setting the
      // lockout first meant it was erased on the very next line: the
      // minute-long brake this class documents, that README promises and
      // that the panel has copy for, never once engaged. Rotate, then
      // lock.
      //
      // The rotation is global because a guessed-at password may have
      // leaked something; the lockout is not, because it must cost the
      // guesser and nobody else.
      this.rotatePassword();
      this.#locks.set(key, Date.now() + 60_000);
    }
    return false;
  }
}

function generatePassword() {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

function sourceKey(source) {
  const cleaned = String(source ?? '').trim().slice(0, 64);
  return cleaned || 'unknown';
}

/**
 * A name the operator will actually recognize in a list.
 *
 * `os.hostname()` is the obvious choice and the wrong one: on a machine
 * with a DHCP-assigned name it returns something like "192.168.0.8",
 * which tells nobody whose computer this is. macOS keeps the friendly
 * name ("Tami's MacBook Air") separately, so ask for that first and fall
 * back to the account name before ever showing an address.
 */
function defaultName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (name) return name.slice(0, 48);
    } catch {
      /* scutil missing or restricted; fall through */
    }
  }

  const host = os.hostname().replace(/\.local$/i, '').trim();
  if (host && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.slice(0, 48);

  try {
    const user = os.userInfo().username;
    if (user) return `${user}'s computer`;
  } catch {
    /* no account info available */
  }

  return "Client's computer";
}
