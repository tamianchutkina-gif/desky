import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(here, '../../..');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: num('PORT', 8080),
  host: process.env.BIND_HOST || '0.0.0.0',

  /** Where the operator console lives, used only for log output. */
  publicUrl: process.env.PUBLIC_URL || null,

  /**
   * Shared secret for coturn's REST-API auth (`use-auth-secret`).
   * Absent means TURN is not offered and connections fall back to
   * STUN-only, which works for most home and office networks but fails
   * behind symmetric NAT.
   */
  turnSecret: process.env.TURN_SECRET || null,
  turnHost: process.env.TURN_HOST || null,
  turnPort: num('TURN_PORT', 3478),
  turnTlsPort: num('TURN_TLS_PORT', 5349),

  /**
   * Set once coturn has a certificate. Until then `turns:` is not
   * advertised, because a TLS candidate with no listener behind it just
   * wastes ICE time and then fails.
   */
  turnTls: process.env.TURN_TLS === '1',
  turnTtlSeconds: num('TURN_TTL', 12 * 60 * 60),

  /**
   * Extra STUN servers, always offered when set.
   *
   * Empty by default, because a deployment with a relay already has a
   * STUN server of its own — coturn answers STUN on the same port it
   * relays on — and telling a third party when every session starts sits
   * badly with "self-hosted".
   */
  stunUrls: list('STUN_URLS', []),

  /**
   * Used only when this deployment has no TURN host to ask.
   *
   * Without a relay configured there is nothing to discover a public
   * address with, and two peers on different networks would be left with
   * host candidates that cannot reach each other. So a stack brought up
   * without TURN still works — it just does so by asking someone else.
   */
  stunFallbackUrls: list('STUN_FALLBACK_URLS', [
    'stun:stun.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
  ]),

  /**
   * How long a client has to accept or decline before the request
   * expires.
   *
   * Two minutes, not one. A minute is plenty for someone who already
   * knows what the window looks like, and far too little for a person
   * meeting it for the first time while an operator explains it over
   * the phone — which is every first session.
   */
  consentTimeoutMs: num('CONSENT_TIMEOUT_MS', 120_000),

  /** Wrong-password attempts allowed per code before it is locked out. */
  maxAuthFailures: num('MAX_AUTH_FAILURES', 5),
  authLockoutMs: num('AUTH_LOCKOUT_MS', 5 * 60_000),

  /** Connection attempts allowed per IP per minute. */
  attemptsPerMinute: num('ATTEMPTS_PER_MINUTE', 30),

  /**
   * New device registrations allowed per IP per hour, and the total the
   * registry will hold. Reclaiming an existing id with a valid token is
   * free; only minting a new one is metered, because each one is a
   * permanent row and a 9-digit code that can never be reused.
   */
  registrationsPerHour: num('REGISTRATIONS_PER_HOUR', 20),
  maxDevices: num('MAX_DEVICES', 100_000),

  heartbeatMs: num('HEARTBEAT_MS', 25_000),

  dataDir: process.env.DATA_DIR || path.join(REPO_ROOT, 'data'),

  /**
   * Where the packaged agent is published for clients to fetch.
   *
   * Outside the repository and outside the image on purpose: the
   * archive is a few hundred megabytes and is rebuilt on a Mac, not
   * here, so it is a directory the deployment drops files into rather
   * than anything this project builds or version-controls.
   */
  downloadDir: process.env.DOWNLOAD_DIR || path.join(REPO_ROOT, 'downloads'),

  /**
   * Restricts which operator consoles may be served this server's
   * signaling socket. Empty means same-origin only.
   */
  allowedOrigins: list('ALLOWED_ORIGINS', []),

  trustProxy: process.env.TRUST_PROXY === '1',
};

export function newId(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}
