import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import { CODE_LENGTH } from '../../../shared/protocol.js';

/**
 * Persistent device registry.
 *
 * A client's 9-digit ID has to survive agent restarts and reboots —
 * asking someone to read out a different number every morning is how a
 * support tool gets abandoned. So the first registration mints an ID
 * plus a secret token, the agent stores both, and later registrations
 * present the token to reclaim the same ID.
 *
 * A flat JSON file is the right size for this. A support practice has
 * tens to hundreds of clients, not millions, and keeping the server
 * dependency-free means it deploys anywhere Node runs.
 */
export class DeviceStore {
  #file;
  #devices = new Map();
  #writeTimer = null;

  /** Set when the registry on disk could not be read and must not be overwritten. */
  #readOnly = false;

  constructor(dataDir = config.dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.#file = path.join(dataDir, 'devices.json');
    this.#load();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      let upgraded = false;
      for (const device of parsed.devices ?? []) {
        if (typeof device.token === 'string' && typeof device.tokenHash !== 'string') {
          device.tokenHash = hashToken(device.token);
          upgraded = true;
        }
        delete device.token;
        this.#devices.set(device.code, device);
      }
      // A registry written before tokens were hashed keeps working and
      // is rewritten once, so no client has to reinstall to be safe.
      if (upgraded) this.#scheduleWrite();
    } catch (err) {
      if (err.code === 'ENOENT') return;

      // Starting empty and then writing is how a truncated file becomes a
      // lost one: the first registration after a bad read overwrites the
      // only copy, and every client's nine-digit ID resets at once. Keep
      // the damaged file for a human to look at, and refuse to persist
      // over it until someone has.
      const aside = `${this.#file}.corrupt`;
      try {
        fs.renameSync(this.#file, aside);
        console.error('[store] device registry is unreadable (%s). Moved it to %s and stopped writing — '
          + 'restore it or delete it, then restart.', err.message, aside);
      } catch (moveErr) {
        console.error('[store] device registry is unreadable (%s) and could not be moved aside (%s). '
          + 'Not writing, so nothing is lost.', err.message, moveErr.message);
      }
      this.#readOnly = true;
    }
  }

  /** Debounced so a burst of reconnects does not thrash the disk. */
  #scheduleWrite() {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#writeNow();
    }, 500);
    this.#writeTimer.unref?.();
  }

  #writeNow() {
    if (this.#readOnly) return;

    const payload = JSON.stringify({ devices: [...this.#devices.values()] }, null, 2);
    const tmp = `${this.#file}.tmp`;
    let handle = null;
    try {
      // Every row holds a token that lets whoever has it register as that
      // client's machine, so the file is no more readable than the agent's
      // own identity file, which has always been 0600.
      handle = fs.openSync(tmp, 'w', 0o600);
      fs.writeFileSync(handle, payload);

      // Flush before the rename. rename is atomic against a reader, but
      // without the fsync a power cut can leave the new name pointing at
      // an empty or half-written file — the exact input that used to cost
      // the whole registry on the next start.
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;

      fs.renameSync(tmp, this.#file);
    } catch (err) {
      console.error('[store] could not persist device registry:', err.message);
      if (handle !== null) { try { fs.closeSync(handle); } catch { /* already closed */ } }
      // A leftover temp file would otherwise sit there until the disk
      // that filled up is emptied by hand.
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    }
  }

  flush() {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    this.#writeNow();
  }

  get size() {
    return this.#devices.size;
  }

  get(code) {
    return this.#devices.get(code) ?? null;
  }

  /**
   * Whether this code and token together name a device already in the
   * registry. The same check `claim` makes, exposed so callers can tell
   * a genuine reclaim from a mint before deciding what to meter.
   */
  verify(code, token) {
    if (typeof code !== 'string' || typeof token !== 'string') return false;
    const existing = this.#devices.get(code);
    return Boolean(existing && tokensMatch(existing.tokenHash, hashToken(token)));
  }

  /**
   * Claims an existing device with a valid token, or mints a new one.
   * Returns `{ code, token, created }`.
   */
  claim({ code, token, name, platform }) {
    if (code && token) {
      const existing = this.#devices.get(code);
      if (existing && tokensMatch(existing.tokenHash, hashToken(token))) {
        existing.name = name || existing.name;
        existing.platform = platform || existing.platform;
        existing.lastSeen = new Date().toISOString();
        this.#scheduleWrite();
        // The token the caller presented, which was just verified. The
        // registry no longer has a plaintext copy to hand back, and the
        // agent already holds this one.
        return { code: existing.code, token, created: false };
      }
    }

    const freshToken = randomBytes(32).toString('hex');
    const fresh = {
      code: this.#allocateCode(),
      tokenHash: hashToken(freshToken),
      name: name || "Client's computer",
      platform: platform || 'unknown',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    this.#devices.set(fresh.code, fresh);
    this.#scheduleWrite();
    return { code: fresh.code, token: freshToken, created: true };
  }

  #allocateCode() {
    const max = 10 ** CODE_LENGTH;
    const min = 10 ** (CODE_LENGTH - 1);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      // randomInt does the rejection sampling that keeps the
      // distribution flat. The plain modulo this replaced biased the low
      // end of the range, which the comment here used to claim it did not.
      const code = String(randomInt(min, max));
      if (!this.#devices.has(code)) return code;
    }
    throw new Error('Could not allocate a free device ID');
  }

  list() {
    return [...this.#devices.values()].map(({ tokenHash, ...rest }) => rest);
  }
}

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Tokens are bearer credentials: whoever holds one can register as that
 * client, displace the agent that is really there, and take the call the
 * operator makes to that number. So the registry stores only what it
 * needs to recognise one. There is no salt because the token is 32
 * random bytes — there is nothing to guess and nothing to precompute.
 */
function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}
