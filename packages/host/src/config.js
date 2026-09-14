import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_QUALITY } from '../shared/protocol.js';

const require = createRequire(import.meta.url);

/**
 * Written at build time by scripts/sync-shared.mjs from DESKY_SERVER.
 * This is how a client gets an agent that already knows where to
 * connect: they double-click an icon, and there is no environment
 * variable in sight.
 */
let baked = { defaultServerUrl: null };
try {
  baked = require('./build-config.json');
} catch {
  /* running from a checkout that has not been synced yet */
}

/**
 * Agent settings, stored beside the identity file.
 *
 * The only setting that really matters is the server address. A client
 * should never have to type it — it is baked into the build they were
 * given. The field in Settings exists so a session can be rescued when
 * someone was handed the wrong installer.
 */
const DEFAULTS = {
  serverUrl: process.env.DESKY_SERVER
    || baked.defaultServerUrl
    || 'ws://localhost:8080/signal',
  // The protocol owns this decision and explains it. A second copy here
  // meant the fallback below it was dead code and every clean install
  // opened at maximum.
  quality: DEFAULT_QUALITY,
  killSwitch: 'CommandOrControl+Alt+Shift+X',
  launchAtLogin: false,
};

export class Config {
  #file;
  #values;

  /**
   * @param {string} [dataDir] Where config.json lives. Defaults to the
   *   agent's user-data directory. Electron is required lazily so that
   *   `normalizeServerUrl` — which decides whether a session travels
   *   encrypted — can be imported and tested without a desktop runtime.
   */
  constructor(dataDir) {
    const dir = dataDir ?? require('electron').app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, 'config.json');
    this.#values = { ...DEFAULTS, ...this.#load() };
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      return {};
    }
  }

  get all() {
    return { ...this.#values };
  }

  get(key) {
    return this.#values[key];
  }

  set(key, value) {
    if (!(key in DEFAULTS)) return;
    this.#values[key] = value;
    this.#save();
  }

  #save() {
    const tmp = `${this.#file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.#values, null, 2));
      fs.renameSync(tmp, this.#file);
    } catch (err) {
      console.error('[config] could not save:', err.message);
    }
  }
}

/**
 * Accepts `https://host`, `wss://host/signal`, or a bare hostname.
 *
 * Plaintext is refused rather than quietly produced. Everything that
 * matters crosses this socket in the clear otherwise — the nonce, the
 * operator's proof of the session password, and the fingerprint
 * signatures that are the only thing standing between a session and a
 * machine in the middle of it. Typing `http://` used to be silently
 * downgraded to `ws://`, with nothing on screen to say the connection
 * had stopped being encrypted.
 *
 * Loopback is the one exception, because there is no network to listen
 * on and it is how the project is developed.
 */
export function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULTS.serverUrl;

  let candidate = raw;
  if (!/^[a-z]+:\/\//i.test(candidate)) candidate = `wss://${candidate}`;

  try {
    const url = new URL(candidate);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    if (url.protocol === 'ws:' && !isLoopback(url.hostname)) return null;
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/signal';
    return url.toString();
  } catch {
    return null;
  }
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
