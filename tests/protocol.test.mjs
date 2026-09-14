import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OP,
  BUTTON,
  MOD,
  KEY_TABLE,
  encodeMouseMove,
  encodeMouseButton,
  encodeWheel,
  encodeKey,
  encodeText,
  decodeInput,
  keyIdFor,
  keyCodeFor,
  formatCode,
  normalizeCode,
  normalizePassword,
  formatPassword,
  PASSWORD_LENGTH,
  PASSWORD_ALPHABET,
  PROOF_ITERATIONS,
  computeProof,
  proofsEqual,
  humanDuration,
  MAX_TEXT_BYTES,
  extractFingerprint,
  computeBinding,
  verifyBinding,
  endedText,
  CTL,
  QUALITY,
  isQualityPreset,
} from '../shared/protocol.js';

/* ------------------------------------------------------------------ *
 * Input codec
 * ------------------------------------------------------------------ */

test('mouse move survives a round trip within float32 precision', () => {
  const frame = decodeInput(encodeMouseMove(0.25, 0.75));
  assert.equal(frame.op, OP.MOUSE_MOVE);
  assert.ok(Math.abs(frame.x - 0.25) < 1e-6);
  assert.ok(Math.abs(frame.y - 0.75) < 1e-6);
});

test('mouse move frame is nine bytes', () => {
  // Mouse motion is the highest-rate message on the wire; if this grows
  // it is worth knowing about.
  assert.equal(encodeMouseMove(0.5, 0.5).byteLength, 9);
});

test('mouse buttons carry their position', () => {
  const down = decodeInput(encodeMouseButton(true, BUTTON.RIGHT, 0.1, 0.2));
  assert.equal(down.op, OP.MOUSE_DOWN);
  assert.equal(down.button, BUTTON.RIGHT);

  const up = decodeInput(encodeMouseButton(false, BUTTON.MIDDLE, 0.9, 0.9));
  assert.equal(up.op, OP.MOUSE_UP);
  assert.equal(up.button, BUTTON.MIDDLE);
});

test('wheel deltas keep their sign and clamp to int16', () => {
  const frame = decodeInput(encodeWheel(-3.4, 7.8));
  assert.equal(frame.op, OP.MOUSE_WHEEL);
  assert.equal(frame.dx, -3);
  assert.equal(frame.dy, 8);

  const huge = decodeInput(encodeWheel(999999, -999999));
  assert.equal(huge.dx, 32767);
  assert.equal(huge.dy, -32768);
});

test('key frames carry the modifier mask', () => {
  const id = keyIdFor('KeyA');
  const frame = decodeInput(encodeKey(true, id, MOD.CTRL | MOD.SHIFT));
  assert.equal(frame.op, OP.KEY_DOWN);
  assert.equal(frame.keyId, id);
  assert.ok(frame.mods & MOD.CTRL);
  assert.ok(frame.mods & MOD.SHIFT);
  assert.ok(!(frame.mods & MOD.ALT));
});

test('text frames survive non-latin characters', () => {
  // The fixtures below are deliberately not English. This path exists so
  // an operator can type text the client's keyboard layout could never
  // produce, so the alphabets it is proven against have to be ones a
  // latin-only encoder would mangle.
  const sample = 'Привет — 你好 — مرحبا — ✓';
  const frame = decodeInput(encodeText(sample));
  assert.equal(frame.op, OP.TEXT);
  assert.equal(frame.text, sample);
});

test('truncated frames decode to null rather than throwing', () => {
  assert.equal(decodeInput(new ArrayBuffer(0)), null);
  assert.equal(decodeInput(new ArrayBuffer(3)), null);

  const short = new Uint8Array([OP.MOUSE_MOVE, 1, 2]).buffer;
  assert.equal(decodeInput(short), null);
});

test('unknown opcodes decode to null', () => {
  assert.equal(decodeInput(new Uint8Array([250, 0, 0, 0]).buffer), null);
});

/* ------------------------------------------------------------------ *
 * Key table
 * ------------------------------------------------------------------ */

test('key table has no duplicates', () => {
  // A duplicate would make two different physical keys share a wire id,
  // so one of them would silently type the wrong character.
  const seen = new Set(KEY_TABLE);
  assert.equal(seen.size, KEY_TABLE.length);
});

test('index 0 is reserved for unknown keys', () => {
  assert.equal(KEY_TABLE[0], '');
  assert.equal(keyIdFor('NoSuchKey'), 0);
  assert.equal(keyCodeFor(0), '');
});

test('key ids round trip', () => {
  for (const code of ['KeyQ', 'Digit7', 'F11', 'ArrowLeft', 'MetaRight', 'Numpad5']) {
    assert.equal(keyCodeFor(keyIdFor(code)), code, code);
  }
});

test('key ids fit in the u16 the wire allocates', () => {
  assert.ok(KEY_TABLE.length < 65536);
});

/* ------------------------------------------------------------------ *
 * Codes and passwords
 * ------------------------------------------------------------------ */

test('codes format in groups of three', () => {
  assert.equal(formatCode('123456789'), '123 456 789');
});

test('code normalization strips everything but digits and caps length', () => {
  assert.equal(normalizeCode(' 123-456 789 '), '123456789');
  assert.equal(normalizeCode('12345678901234'), '123456789');
});

test('password normalization uppercases and caps length', () => {
  assert.equal(normalizePassword('ab3d-9k qm'), 'AB3D9KQM');
  assert.equal(normalizePassword('abcdefghijkl'), 'ABCDEFGH');
});

test('passwords read aloud in two runs of four', () => {
  assert.equal(formatPassword('AB3D9KQM'), 'AB3D 9KQM');
  // The operator may type it with the space or without; both normalize
  // to the same eight characters, so both must produce the same proof.
  assert.equal(normalizePassword('AB3D 9KQM'), normalizePassword('AB3D9KQM'));
});

test('the password is eight characters of an unambiguous alphabet', () => {
  assert.equal(PASSWORD_LENGTH, 8);
  // 0/O and 1/I/l are absent because this is read aloud and typed by ear.
  for (const forbidden of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!PASSWORD_ALPHABET.includes(forbidden), `${forbidden} is ambiguous aloud`);
  }
});

/* ------------------------------------------------------------------ *
 * Challenge-response
 * ------------------------------------------------------------------ */

test('the same inputs produce the same proof', async () => {
  const a = await computeProof('AB3D9KQM', 'nonce-1', '123456789', 'sess-1');
  const b = await computeProof('AB3D9KQM', 'nonce-1', '123456789', 'sess-1');
  assert.equal(a, b);
});

test('a proof is bound to the nonce, the code and the session', async () => {
  const base = await computeProof('AB3D9KQM', 'nonce-1', '123456789', 'sess-1');

  // Replaying a captured proof against a different session or a
  // different machine must not authenticate.
  assert.notEqual(base, await computeProof('AB3D9KQM', 'nonce-2', '123456789', 'sess-1'));
  assert.notEqual(base, await computeProof('AB3D9KQM', 'nonce-1', '987654321', 'sess-1'));
  assert.notEqual(base, await computeProof('AB3D9KQM', 'nonce-1', '123456789', 'sess-2'));
  assert.notEqual(base, await computeProof('WRONG1QM', 'nonce-1', '123456789', 'sess-1'));
});

test('a proof is not a bare HMAC over the password', async () => {
  // The defence against a malicious server searching offline is that
  // each candidate costs a key derivation rather than one hash. If
  // somebody ever simplifies proofKey back to importKey, this fails.
  assert.ok(PROOF_ITERATIONS >= 1_000_000);

  const password = 'AB3D9KQM';
  const sessionId = 'sess-1';
  const message = new TextEncoder().encode(`nonce-1|123456789|${sessionId}|2`);

  const bare = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const unstretched = [...new Uint8Array(await crypto.subtle.sign('HMAC', bare, message))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  assert.notEqual(await computeProof(password, 'nonce-1', '123456789', sessionId), unstretched);
});

test('the derived key is salted per session', async () => {
  // Same message shape, different session: an attacker who has paid for
  // one session's derivation has paid for nothing else.
  const a = await computeProof('AB3D9KQM', 'n', '123456789', 'sess-1');
  const b = await computeProof('AB3D9KQM', 'n', '123456789', 'sess-2');
  assert.notEqual(a, b);
});

test('proof comparison rejects mismatched lengths and values', () => {
  assert.ok(proofsEqual('abc', 'abc'));
  assert.ok(!proofsEqual('abc', 'abd'));
  assert.ok(!proofsEqual('abc', 'abcd'));
  assert.ok(!proofsEqual(null, 'abc'));
  assert.ok(!proofsEqual(undefined, undefined));
});

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

test('durations gain an hours field only when needed', () => {
  assert.equal(humanDuration(0), '00:00');
  assert.equal(humanDuration(65_000), '01:05');
  assert.equal(humanDuration(3_600_000), '1:00:00');
  assert.equal(humanDuration(3_725_000), '1:02:05');
});

test('negative durations clamp rather than render nonsense', () => {
  assert.equal(humanDuration(-5000), '00:00');
});

/* ------------------------------------------------------------------ *
 * Views into pooled buffers
 * ------------------------------------------------------------------ */

test('frames decode correctly out of a view with a non-zero offset', () => {
  // Node hands out pooled Buffers that are views into a much larger
  // allocation. Reading `.buffer` and ignoring the offset reads the
  // wrong bytes while every length check still passes.
  const frame = new Uint8Array(encodeMouseMove(0.25, 0.75));
  const pool = new Uint8Array(64);
  pool.set(frame, 17);
  const view = new Uint8Array(pool.buffer, 17, frame.length);

  const decoded = decodeInput(view);
  assert.equal(decoded.op, OP.MOUSE_MOVE);
  assert.ok(Math.abs(decoded.x - 0.25) < 1e-6);
  assert.ok(Math.abs(decoded.y - 0.75) < 1e-6);
});

test('text frames decode out of an offset view', () => {
  const frame = new Uint8Array(encodeText('Привет'));
  const pool = new Uint8Array(128);
  pool.set(frame, 9);
  const decoded = decodeInput(new Uint8Array(pool.buffer, 9, frame.length));
  assert.equal(decoded.text, 'Привет');
});

test('oversized text is truncated rather than wrapping the length field', () => {
  const huge = 'я'.repeat(70_000);
  const decoded = decodeInput(encodeText(huge));
  assert.equal(decoded.op, OP.TEXT);
  assert.ok(decoded.text.length > 0);
  assert.ok(new TextEncoder().encode(decoded.text).length <= MAX_TEXT_BYTES);
});

test('non-buffer input decodes to null', () => {
  assert.equal(decodeInput(null), null);
  assert.equal(decodeInput('nonsense'), null);
  assert.equal(decodeInput(42), null);
});

/* ------------------------------------------------------------------ *
 * Connection binding
 * ------------------------------------------------------------------ */

const SDP_A = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
  + 'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11\r\n';
const SDP_B = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
  + 'a=fingerprint:sha-256 99:88:77:66:55:44:33:22\r\n';

test('a fingerprint is read out of an sdp', () => {
  assert.equal(extractFingerprint(SDP_A), 'sha-256 AA:BB:CC:DD:EE:FF:00:11');
});

test('an sdp carrying two different fingerprints is refused', () => {
  // More than one identity in a bundled description means something
  // rewrote part of it.
  assert.equal(extractFingerprint(SDP_A + SDP_B), null);
  assert.equal(extractFingerprint('v=0\r\n'), null);
  assert.equal(extractFingerprint(null), null);
});

test('a binding made with the password verifies', async () => {
  const bind = await computeBinding('AB3D9KQM', 'offer', 'sess-1', extractFingerprint(SDP_A));
  assert.ok(await verifyBinding('AB3D9KQM', 'offer', 'sess-1', SDP_A, bind));
});

test('a server swapping in its own sdp cannot forge a binding', async () => {
  // The whole point: the server relays the signalling but never learns
  // the password, so it cannot re-sign a description it substituted.
  const genuine = await computeBinding('AB3D9KQM', 'offer', 'sess-1', extractFingerprint(SDP_A));
  assert.ok(!await verifyBinding('AB3D9KQM', 'offer', 'sess-1', SDP_B, genuine));
});

test('a binding does not transfer across role, session or password', async () => {
  const bind = await computeBinding('AB3D9KQM', 'offer', 'sess-1', extractFingerprint(SDP_A));
  assert.ok(!await verifyBinding('AB3D9KQM', 'answer', 'sess-1', SDP_A, bind));
  assert.ok(!await verifyBinding('AB3D9KQM', 'offer', 'sess-2', SDP_A, bind));
  assert.ok(!await verifyBinding('WRONG1QM', 'offer', 'sess-1', SDP_A, bind));
});

test('a stripped binding is refused', async () => {
  // An attacker must not be able to downgrade by simply omitting it.
  assert.ok(!await verifyBinding('AB3D9KQM', 'offer', 'sess-1', SDP_A, undefined));
  assert.ok(!await verifyBinding('AB3D9KQM', 'offer', 'sess-1', SDP_A, ''));
  assert.ok(!await verifyBinding('AB3D9KQM', 'offer', 'sess-1', SDP_A, null));
});

test('every reason the server actually sends has words for it', () => {
  // hub.js:95 sends exactly these two when a socket drops mid-session.
  for (const reason of ['host_disconnected', 'operator_disconnected']) {
    assert.notEqual(endedText(reason), endedText('anything-unknown'),
      `${reason} falls through to the generic text, so the operator is told nothing`);
  }
});

test('a frame whose coordinates are not numbers is refused', () => {
  // The decoder is the validation boundary for a channel whose bytes are
  // injected into the client's machine the moment they arrive. NaN
  // survives the clamp in the injector and reaches native code.
  assert.equal(decodeInput(encodeMouseMove(NaN, 0.5)), null);
  assert.equal(decodeInput(encodeMouseMove(0.5, NaN)), null);
  assert.equal(decodeInput(encodeMouseMove(Infinity, 0.5)), null);
  assert.equal(decodeInput(encodeMouseButton(true, BUTTON.LEFT, NaN, 0.5)), null);
  assert.equal(decodeInput(encodeMouseButton(false, BUTTON.LEFT, 0.5, -Infinity)), null);
});

test('ordinary and out-of-range coordinates still decode', () => {
  assert.equal(decodeInput(encodeMouseMove(0.25, 0.75)).x, 0.25);
  // Out of range is the injector's business to clamp, not the decoder's
  // to reject: a refused position is a cursor that stops before an edge.
  assert.ok(decodeInput(encodeMouseMove(-0.5, 1.5)));
});

test('a quality preset is checked before it is trusted', () => {
  for (const name of Object.keys(QUALITY)) {
    assert.equal(isQualityPreset(name), true);
  }
  for (const junk of ['', 'MAX', 'ultra', 0, 1, null, undefined, {}, ['balanced'], 'toString', '__proto__']) {
    assert.equal(isQualityPreset(junk), false, `${String(junk)} is not a preset`);
  }
});

test('the control vocabulary has a name for reconciling held keys', () => {
  assert.equal(CTL.HELD, 'held');
  // Every value in the table has to be distinct, or two messages collide.
  const values = Object.values(CTL);
  assert.equal(new Set(values).size, values.length);
});
