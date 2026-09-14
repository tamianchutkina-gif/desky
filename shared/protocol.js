/**
 * Desky wire protocol — single source of truth.
 *
 * Loaded unmodified by four different runtimes:
 *   - the signaling server (Node),
 *   - the host agent's Electron main process (Node),
 *   - the host agent's renderer processes (Chromium, file://),
 *   - the operator console (Chromium, https://).
 *
 * Therefore: pure ESM, zero imports, zero platform APIs.
 */

export const PROTOCOL_VERSION = 2;

/* ------------------------------------------------------------------ *
 * Signaling messages (JSON over WebSocket)
 * ------------------------------------------------------------------ */

export const MSG = {
  // host -> server
  HOST_REGISTER: 'host:register',
  HOST_DECISION: 'host:decision',
  HOST_END: 'host:end',
  HOST_ROTATE: 'host:rotate',

  // server -> host
  HOST_REGISTERED: 'host:registered',
  HOST_REQUEST: 'host:request',
  HOST_PEER_GONE: 'host:peer-gone',

  // operator -> server
  OP_LOOKUP: 'op:lookup',
  OP_AUTH: 'op:auth',
  OP_END: 'op:end',

  // server -> operator
  OP_CHALLENGE: 'op:challenge',
  OP_PENDING: 'op:pending',
  OP_ACCEPTED: 'op:accepted',
  OP_REJECTED: 'op:rejected',
  OP_PEER_GONE: 'op:peer-gone',

  // both directions, relayed verbatim
  SIGNAL: 'signal',

  // housekeeping
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
};

/** Reasons a connection attempt can fail. Rendered to Russian text by the UIs. */
export const REJECT = {
  BAD_CODE: 'bad_code',
  BAD_PASSWORD: 'bad_password',
  DECLINED: 'declined',
  TIMEOUT: 'timeout',
  BUSY: 'busy',
  LOCKED: 'locked',
  VERSION: 'version',
  RATE_LIMITED: 'rate_limited',
  DISPLACED: 'displaced',
};

/* ------------------------------------------------------------------ *
 * Input channel — binary frames over an unreliable DataChannel
 * ------------------------------------------------------------------ *
 *
 * Mouse motion can reach 500 events/second. JSON plus a reliable,
 * ordered channel would mean head-of-line blocking: one lost packet
 * stalls every later position until it is retransmitted, and the
 * cursor visibly freezes then teleports. Binary frames on an
 * unreliable channel drop stale positions instead of queueing them,
 * which is what makes remote control feel local.
 *
 * Coordinates travel normalized to 0..1 of the shared display, so they
 * survive a resolution change or a switch to another monitor without
 * renegotiation.
 */

export const OP = {
  MOUSE_MOVE: 1,
  MOUSE_DOWN: 2,
  MOUSE_UP: 3,
  MOUSE_WHEEL: 4,
  KEY_DOWN: 5,
  KEY_UP: 6,
  TEXT: 7,
};

export const BUTTON = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };

export const MOD = { SHIFT: 1, CTRL: 2, ALT: 4, META: 8 };

export function encodeMouseMove(x, y) {
  const b = new ArrayBuffer(9);
  const v = new DataView(b);
  v.setUint8(0, OP.MOUSE_MOVE);
  v.setFloat32(1, x, true);
  v.setFloat32(5, y, true);
  return b;
}

export function encodeMouseButton(down, button, x, y) {
  const b = new ArrayBuffer(10);
  const v = new DataView(b);
  v.setUint8(0, down ? OP.MOUSE_DOWN : OP.MOUSE_UP);
  v.setUint8(1, button);
  v.setFloat32(2, x, true);
  v.setFloat32(6, y, true);
  return b;
}

export function encodeWheel(dx, dy) {
  const b = new ArrayBuffer(5);
  const v = new DataView(b);
  v.setUint8(0, OP.MOUSE_WHEEL);
  v.setInt16(1, clampInt16(dx), true);
  v.setInt16(3, clampInt16(dy), true);
  return b;
}

export function encodeKey(down, keyId, mods) {
  const b = new ArrayBuffer(4);
  const v = new DataView(b);
  v.setUint8(0, down ? OP.KEY_DOWN : OP.KEY_UP);
  v.setUint8(1, mods & 0xff);
  v.setUint16(2, keyId, true);
  return b;
}

const utf8Encode = new TextEncoder();
const utf8Decode = new TextDecoder();

/** The length field is a u16, so anything longer would silently wrap. */
export const MAX_TEXT_BYTES = 0xffff;

/**
 * Largest cut point at or before `limit` that does not split a
 * character.
 *
 * Cutting mid-sequence is worse than it sounds: the fragment decodes to
 * a replacement character, which re-encodes to *three* bytes — so a
 * naive truncation to exactly the limit can come back over it.
 */
function utf8BoundaryAtOrBefore(bytes, limit) {
  let end = Math.min(limit, bytes.length);
  // Continuation bytes are 10xxxxxx; walk back off them to the lead byte.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

export function encodeText(text) {
  let payload = utf8Encode.encode(text);
  if (payload.length > MAX_TEXT_BYTES) {
    payload = payload.subarray(0, utf8BoundaryAtOrBefore(payload, MAX_TEXT_BYTES));
  }
  const b = new ArrayBuffer(3 + payload.length);
  const v = new DataView(b);
  v.setUint8(0, OP.TEXT);
  v.setUint16(1, payload.length, true);
  new Uint8Array(b, 3).set(payload);
  return b;
}

/**
 * Returns a plain object, or null if the frame is malformed.
 *
 * Accepts an ArrayBuffer or any view of one. Reading `.buffer` off a
 * view and ignoring its offset would be a real bug rather than a
 * pedantic one: Node hands out pooled Buffers that are views into a
 * much larger allocation, so every field would be read from the wrong
 * place while the length checks still passed.
 */
export function decodeInput(buffer) {
  let v;
  let length;

  if (ArrayBuffer.isView(buffer)) {
    length = buffer.byteLength;
    v = new DataView(buffer.buffer, buffer.byteOffset, length);
  } else if (buffer instanceof ArrayBuffer) {
    length = buffer.byteLength;
    v = new DataView(buffer);
  } else {
    return null;
  }

  if (length < 1) return null;
  const op = v.getUint8(0);

  switch (op) {
    case OP.MOUSE_MOVE: {
      if (length < 9) return null;
      const x = v.getFloat32(1, true);
      const y = v.getFloat32(5, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { op, x, y };
    }

    case OP.MOUSE_DOWN:
    case OP.MOUSE_UP: {
      if (length < 10) return null;
      const x = v.getFloat32(2, true);
      const y = v.getFloat32(6, true);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { op, button: v.getUint8(1), x, y };
    }

    case OP.MOUSE_WHEEL:
      if (length < 5) return null;
      return { op, dx: v.getInt16(1, true), dy: v.getInt16(3, true) };

    case OP.KEY_DOWN:
    case OP.KEY_UP:
      if (length < 4) return null;
      return { op, mods: v.getUint8(1), keyId: v.getUint16(2, true) };

    case OP.TEXT: {
      if (length < 3) return null;
      const len = v.getUint16(1, true);
      if (length < 3 + len) return null;
      // Offsets are taken from the view, not the underlying buffer.
      return { op, text: utf8Decode.decode(new Uint8Array(v.buffer, v.byteOffset + 3, len)) };
    }

    default:
      return null;
  }
}

function clampInt16(n) {
  return Math.max(-32768, Math.min(32767, Math.round(n)));
}

/* ------------------------------------------------------------------ *
 * Control channel — JSON over a reliable DataChannel
 * ------------------------------------------------------------------ */

export const CTL = {
  HELLO: 'hello',
  DISPLAYS: 'displays',
  SELECT_DISPLAY: 'select-display',
  QUALITY: 'quality',
  CLIPBOARD_PUSH: 'clipboard-push',
  CLIPBOARD_PULL: 'clipboard-pull',
  CLIPBOARD_DATA: 'clipboard-data',
  PING: 'ping',
  PONG: 'pong',
  ACTIVITY: 'activity',
  HELD: 'held',
  BYE: 'bye',
};

/**
 * Quality presets. `bitrate` is bits/second.
 *
 * Chromium caps screen-share bitrate around 2.5 Mbps by default, which
 * turns text into mush the moment anything scrolls. Every preset here
 * overrides that ceiling explicitly via RTCRtpSender.setParameters.
 */
/*
 * A width to encode at, rather than a factor to divide by. A fixed
 * factor means something different on every machine: `1.5` is 1920 wide
 * on a 2880-pixel laptop and 960 on a 1440-pixel one, so the same
 * preset asked one client for four times the pixels of another. The
 * operator's window is around 1400 pixels wide whatever the client has,
 * and everything sent above that is encoded, transmitted and then
 * thrown away by the scaler.
 */
export const QUALITY = {
  max: { label: 'Maximum', fps: 60, bitrate: 40_000_000, maxWidth: 3840 },
  balanced: { label: 'Balanced', fps: 30, bitrate: 12_000_000, maxWidth: 1920 },
  eco: { label: 'Low bandwidth', fps: 20, bitrate: 3_000_000, maxWidth: 1280 },
};

/*
 * Balanced, not maximum. 60 fps at 40 Mbit/s is a local-network
 * setting; over the internet the encoder aims for a ceiling the link
 * cannot carry, congestion control claws it back, and the operator
 * meets a session that works and is unusably slow. The first real
 * session between two homes ran at 22 kbit/s and four frames.
 */
export const DEFAULT_QUALITY = 'balanced';

/**
 * Whether a value names a preset.
 *
 * The operator's browser chooses the preset, and the agent persists it,
 * so this is remote input writing durable state onto the client's disk.
 * `Object.hasOwn` rather than a truthiness test on `QUALITY[value]`, so
 * `'toString'` and `'__proto__'` are not presets.
 */
export function isQualityPreset(value) {
  return typeof value === 'string' && Object.hasOwn(QUALITY, value);
}

/* ------------------------------------------------------------------ *
 * Key table
 * ------------------------------------------------------------------ *
 *
 * The wire carries a u16 index into KEY_TABLE rather than a string, so
 * a keystroke is 4 bytes. Index 0 is reserved for "unknown".
 *
 * ORDER IS PART OF THE PROTOCOL. Append new keys at the end; never
 * reorder or delete, or an old host will type the wrong character for
 * a new operator console.
 */
export const KEY_TABLE = [
  '',
  'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI',
  'KeyJ', 'KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR',
  'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Escape', 'Backspace', 'Tab', 'Space', 'Enter', 'Delete',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash',
  'CapsLock',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'PrintScreen', 'ScrollLock', 'Pause',
  'Insert', 'Home', 'PageUp', 'End', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'NumLock',
  'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', 'NumpadAdd',
  'NumpadEnter', 'NumpadDecimal',
  'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4',
  'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9',
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
  'ContextMenu',
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18',
  'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
  'IntlBackslash', 'IntlRo', 'IntlYen',
];

const KEY_INDEX = new Map(KEY_TABLE.map((code, i) => [code, i]));

/** DOM KeyboardEvent.code -> wire id. Returns 0 for keys we do not carry. */
export function keyIdFor(code) {
  return KEY_INDEX.get(code) ?? 0;
}

/** Wire id -> DOM KeyboardEvent.code. */
export function keyCodeFor(id) {
  return KEY_TABLE[id] ?? '';
}

/* ------------------------------------------------------------------ *
 * Access codes
 * ------------------------------------------------------------------ */

/** 9 digits, displayed as 3-3-3. Familiar to anyone who has used AnyDesk. */
export const CODE_LENGTH = 9;

export function formatCode(code) {
  const digits = String(code).replace(/\D/g, '');
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

export function normalizeCode(input) {
  return String(input).replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** Session password alphabet: no 0/O/1/I/l, so it survives being read aloud. */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PASSWORD_LENGTH = 8;

/** Read aloud in two runs of four, the way the machine number is read in threes. */
export const PASSWORD_GROUP = 4;

export function normalizePassword(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, PASSWORD_LENGTH);
}

export function formatPassword(password) {
  const chars = normalizePassword(password);
  return chars.replace(new RegExp(`(.{${PASSWORD_GROUP}})(?=.)`, 'g'), '$1 ');
}

/* ------------------------------------------------------------------ *
 * Why the password is stretched before it is used as a key
 * ------------------------------------------------------------------ *
 *
 * Everything below signs with the session password. A malicious
 * signaling server holds every other input to those signatures — the
 * nonce it issued, the code, the session id, the protocol version — so
 * it can guess passwords offline, against the proof it just relayed,
 * as fast as it can compute the function. With a bare HMAC over six
 * characters of a 31-character alphabet that is 8.6e8 candidates at one
 * hash each: a laptop finishes before the operator has finished typing.
 * And a recovered password forges the fingerprint bindings that are the
 * whole reason a substituted SDP is detectable.
 *
 * Two changes, together:
 *
 *   - eight characters rather than six, 31^8 ~= 8.5e11, about 39.6 bits;
 *   - the key is derived with PBKDF2-SHA-256 rather than being the
 *     password itself, so each candidate costs 1.2 million iterations
 *     instead of one hash.
 *
 * That is about 2e18 SHA-256 compressions to exhaust the space. A
 * current GPU manages a few thousand candidates a second against this
 * KDF, so one is busy for over a decade and a thousand of them for
 * days — while the password itself is alive for the length of one
 * session and rotates on every ending, including a decline and a
 * timeout. The attack does not become impossible; it becomes late,
 * which for a credential with this lifetime is the same thing.
 *
 * It is still not a PAKE. A PAKE would mean the server never sees a
 * value derived from the password at all, and it is the only thing that
 * closes this properly. This makes the shortcut expensive rather than
 * free.
 *
 * The cost to the honest side is 1.2 million iterations, measured at
 * 143 ms on the machine this was written on, three times per session —
 * the proof, one binding made, one binding checked. WebCrypto runs it
 * off the main thread in both Node and Chromium, so nothing blocks, and
 * a human is reading a password aloud while it happens. Deriving per
 * call rather than caching keeps this file stateless, which is what
 * lets four different runtimes load it verbatim.
 *
 * Raising the count is a wire break: both sides must agree, so it
 * belongs with a PROTOCOL_VERSION bump, not on its own.
 */
export const PROOF_ITERATIONS = 1_200_000;

async function proofKey(password, sessionId) {
  const material = await crypto.subtle.importKey(
    'raw',
    utf8Encode.encode(normalizePassword(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  // The salt is public and per-session on purpose: it costs an attacker
  // nothing to learn, and it stops one table of precomputed keys from
  // serving every session and every deployment at once.
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: utf8Encode.encode(`desky|proof|${PROTOCOL_VERSION}|${sessionId}`),
      iterations: PROOF_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/* ------------------------------------------------------------------ *
 * Challenge-response
 * ------------------------------------------------------------------ *
 *
 * The signaling server never learns the session password. The operator
 * proves knowledge of it against a server-issued nonce, and the host
 * agent — the machine that actually owns the password — is the only
 * party that verifies the proof. A compromised server can therefore
 * disrupt a connection but never authorize one.
 *
 * Implemented with WebCrypto, which all four runtimes provide.
 */
export async function computeProof(password, nonce, code, sessionId) {
  const key = await proofKey(password, sessionId);
  const message = utf8Encode.encode(`${nonce}|${code}|${sessionId}|${PROTOCOL_VERSION}`);
  const sig = await crypto.subtle.sign('HMAC', key, message);
  return bufferToHex(sig);
}

/* ------------------------------------------------------------------ *
 * Binding the connection to the password
 * ------------------------------------------------------------------ *
 *
 * The challenge-response above proves the operator knows the password.
 * It does not, on its own, prove that the peer you end up encrypting to
 * is that same operator — because the server is the one deciding whose
 * SDP reaches whom. A malicious server can answer the operator with its
 * own offer and the host with its own answer, and sit in the middle of
 * a session both ends believe is direct.
 *
 * DTLS-SRTP already guarantees you are talking to whoever owns the
 * fingerprint in the SDP. So each side signs its own fingerprint with
 * the session password, and the other side checks it. The server never
 * learns the password, so it cannot forge a binding for a fingerprint
 * it controls — which is what makes "the server can break a session but
 * never watch one" true rather than aspirational.
 */

/** Pulls the DTLS fingerprint out of an SDP. Null if absent or inconsistent. */
export function extractFingerprint(sdp) {
  if (typeof sdp !== 'string') return null;

  const found = new Set();
  for (const line of sdp.split(/\r\n|\r|\n/)) {
    const match = /^a=fingerprint:\s*(\S+)\s+(\S+)/i.exec(line.trim());
    if (match) found.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
  }

  // Bundled sessions carry one identity. More than one distinct value
  // means something rewrote part of the description.
  if (found.size !== 1) return null;
  return [...found][0];
}

export async function computeBinding(password, role, sessionId, fingerprint) {
  const key = await proofKey(password, sessionId);
  const message = utf8Encode.encode(
    `bind|${role}|${sessionId}|${fingerprint}|${PROTOCOL_VERSION}`,
  );
  return bufferToHex(await crypto.subtle.sign('HMAC', key, message));
}

/**
 * Verifies that an SDP came from someone holding the session password.
 * Returns false for a missing binding, so an attacker cannot strip it.
 */
export async function verifyBinding(password, role, sessionId, sdp, binding) {
  if (typeof binding !== 'string' || binding.length === 0) return false;
  const fingerprint = extractFingerprint(sdp);
  if (!fingerprint) return false;
  const expected = await computeBinding(password, role, sessionId, fingerprint);
  return proofsEqual(binding, expected);
}

/**
 * Compares two hex digests without leaking which byte differed.
 *
 * The length check short-circuits, so this is only constant-time for
 * equal-length inputs — which is all that is needed here, since every
 * value compared is a SHA-256 digest of fixed, public length.
 */
export function proofsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

export function humanDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Why a running session ended, in words the operator can act on.
 *
 * Everything used to be reported as "The client ended the session",
 * including a two-second Wi-Fi drop and a monitor being unplugged. That
 * is a factual claim about a person's decision, and when it is wrong the
 * operator stops trusting the screen — and calls the client to ask about
 * something they never did.
 */
export function endedText(reason) {
  switch (reason) {
    case 'client_ended': return 'The client ended the session';
    case 'kill_switch': return 'The client ended the session with the kill switch';
    case 'operator_ended': return 'You ended the session';
    case 'agent_quit': return 'The client quit Desky';
    case 'capture_ended': return 'The shared screen went away — a monitor was unplugged, slept, or sharing was stopped';
    case 'capture_denied': return 'macOS stopped the screen recording on the client’s machine';
    case 'connection_failed': return 'The connection between your two computers failed';
    case 'engine_crashed': return 'The client’s agent hit an error and stopped';
    case 'binding_failed': return 'The client’s machine could not confirm who was connecting';
    case 'no_fingerprint': return 'The connection could not be secured and was stopped';
    case 'host_gone':
    case 'host_disconnected':
    case 'peer_disconnected': return 'The client’s computer lost its connection to the server';
    case 'operator_disconnected': return 'Your connection to the server dropped';
    case 'server_shutdown': return 'The server restarted';
    default: return 'The session ended';
  }
}

export function rejectionText(reason) {
  switch (reason) {
    case REJECT.BAD_CODE: return 'No computer with that ID is online';
    case REJECT.BAD_PASSWORD: return 'Wrong session password';
    case REJECT.DECLINED: return 'The client declined the request';
    case REJECT.TIMEOUT: return 'The client did not answer the request';
    case REJECT.BUSY: return 'Someone is already connected to this computer';
    case REJECT.LOCKED: return 'Locked for a few minutes after repeated wrong passwords';
    case REJECT.VERSION: return 'The agent and this console are different versions';
    case REJECT.RATE_LIMITED: return 'Too many attempts — wait a minute';
    default: return 'Could not connect';
  }
}
