import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Identity } from '../packages/host/src/identity.js';
import { computeProof, PASSWORD_ALPHABET, PASSWORD_LENGTH } from '../shared/protocol.js';

/**
 * The agent's own gate.
 *
 * `Identity` decides whether an operator gets to raise a consent dialog
 * on someone's machine, and until now nothing tested it. That is how a
 * lockout that set its deadline and then erased it on the very next line
 * shipped: every piece of code around it — the panel copy, the countdown
 * timer in main, the promise in the README — was written for a state the
 * class could never be in.
 */

function freshIdentity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-identity-'));
  return new Identity(dir);
}

const BAD_PROOF = 'ab'.repeat(32);
const nonceFor = (label) => `${label}${'0'.repeat(32)}`;

test('a correct proof is accepted', async () => {
  const identity = freshIdentity();
  const nonce = nonceFor('a');
  const proof = await computeProof(identity.password, nonce, identity.code, 'session-1');

  assert.equal(await identity.verify({ proof, nonce, sessionId: 'session-1' }), true);
});

test('three wrong proofs lock the machine for a minute', async () => {
  const identity = freshIdentity();

  assert.equal(identity.locked, false);
  await identity.verify({ proof: BAD_PROOF, nonce: nonceFor('a'), sessionId: 's1' });
  await identity.verify({ proof: BAD_PROOF, nonce: nonceFor('b'), sessionId: 's2' });
  assert.equal(identity.locked, false, 'two failures are not yet a lockout');

  await identity.verify({ proof: BAD_PROOF, nonce: nonceFor('c'), sessionId: 's3' });

  assert.equal(identity.locked, true);
  assert.ok(identity.lockRemainingMs > 55_000, 'the countdown the panel renders must be real');
  assert.ok(identity.lockRemainingMs <= 60_000);
});

test('a stranger guessing at the password cannot change it', async () => {
  const identity = freshIdentity();
  const original = identity.password;

  for (const label of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await identity.verify({ proof: BAD_PROOF, nonce: nonceFor(label), sessionId: label });
  }

  assert.equal(identity.password, original,
    'rotating on failures let anyone with the id change the password every minute — a denial of service, not a defence');
  assert.equal(identity.locked, true, 'the guesser is still locked out');
});

test('even a correct proof is refused while locked', async () => {
  const identity = freshIdentity();
  for (const label of ['a', 'b', 'c']) {
    await identity.verify({ proof: BAD_PROOF, nonce: nonceFor(label), sessionId: label });
  }

  const nonce = nonceFor('d');
  const proof = await computeProof(identity.password, nonce, identity.code, 'after-lock');
  assert.equal(await identity.verify({ proof, nonce, sessionId: 'after-lock' }), false);
});

test('rotating by hand clears the lockout', async () => {
  const identity = freshIdentity();
  for (const label of ['a', 'b', 'c']) {
    await identity.verify({ proof: BAD_PROOF, nonce: nonceFor(label), sessionId: label });
  }
  assert.equal(identity.locked, true);

  identity.rotatePassword();
  assert.equal(identity.locked, false, 'the client asking for a new password is a way out');
});

test('a proof cannot be presented twice', async () => {
  const identity = freshIdentity();
  const nonce = nonceFor('a');
  const proof = await computeProof(identity.password, nonce, identity.code, 'session-1');

  assert.equal(await identity.verify({ proof, nonce, sessionId: 'session-1' }), true);
  assert.equal(await identity.verify({ proof, nonce, sessionId: 'session-1' }), false);
});

test('two copies of one proof arriving together admit exactly one', async () => {
  const identity = freshIdentity();
  const nonce = nonceFor('a');
  const proof = await computeProof(identity.password, nonce, identity.code, 'session-1');

  // The nonce is claimed before the hash is computed, so the second
  // caller cannot slip through the window the await used to open.
  const results = await Promise.all([
    identity.verify({ proof, nonce, sessionId: 'session-1' }),
    identity.verify({ proof, nonce, sessionId: 'session-1' }),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
});

test('a short or missing nonce is refused before anything is hashed', async () => {
  const identity = freshIdentity();
  for (const nonce of ['', 'tooshort', null, undefined, 12345]) {
    assert.equal(await identity.verify({ proof: BAD_PROOF, nonce, sessionId: 's' }), false);
  }
});

test('the session password is drawn from the unambiguous alphabet', () => {
  const identity = freshIdentity();
  assert.equal(identity.password.length, PASSWORD_LENGTH);
  for (const character of identity.password) {
    assert.ok(PASSWORD_ALPHABET.includes(character), `${character} is not in the alphabet`);
  }
  // Nothing that can be misread over the phone: I against 1, O against
  // 0, and L against both. U stays — it is in the alphabet, and a test
  // that forbade it failed roughly one run in six for no reason.
  assert.equal(/[ILO01]/.test(identity.password), false);
  for (const excluded of 'ILO01') {
    assert.equal(PASSWORD_ALPHABET.includes(excluded), false, `${excluded} must not be in the alphabet`);
  }
});

test('rotating produces a different password', () => {
  const identity = freshIdentity();
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) seen.add(identity.rotatePassword());
  assert.ok(seen.size > 15, 'passwords must not repeat in a short run');
});

test('the identity file is written for its owner only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-identity-'));
  const identity = new Identity(dir);
  identity.adopt({ code: '123456789', token: 'f'.repeat(64) });

  const file = path.join(dir, 'identity.json');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('an id and token survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-identity-'));
  const first = new Identity(dir);
  first.adopt({ code: '123456789', token: 'f'.repeat(64) });

  const second = new Identity(dir);
  assert.equal(second.code, '123456789');
  assert.equal(second.token, 'f'.repeat(64));

  // The password does not: a new run means a new one, so a proof
  // captured before a restart is dead.
  assert.notEqual(second.password, first.password);
});

test('a corrupted identity file starts clean rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-identity-'));
  fs.writeFileSync(path.join(dir, 'identity.json'), '{ not json at all');

  const identity = new Identity(dir);
  assert.equal(identity.code, null);
  assert.ok(identity.name);
});

test('a stranger cannot lock out the operator who has the password', async () => {
  const identity = freshIdentity();
  const firstPassword = identity.password;

  // Someone who only knows the nine-digit id burns three guesses.
  for (const label of ['a', 'b', 'c']) {
    await identity.verify({
      proof: BAD_PROOF,
      nonce: nonceFor(label),
      sessionId: `s-${label}`,
      source: '198.51.100.7',
    });
  }

  assert.equal(identity.lockedFor('198.51.100.7'), true, 'the guesser pays for the guesses');
  assert.equal(identity.lockedFor('203.0.113.4'), false, 'the honest operator must not inherit that lock');
  assert.equal(identity.password, firstPassword, 'the guesses must not cost the client a new password either');

  // The operator, holding the password the client already read out, gets in at once.
  const nonce = nonceFor('d');
  const proof = await computeProof(identity.password, nonce, identity.code, 's-d');
  assert.equal(
    await identity.verify({ proof, nonce, sessionId: 's-d', source: '203.0.113.4' }),
    true,
    'support has to still be possible while a stranger is probing the id',
  );
});

test('a correct password during someone else’s lockout is not counted as a guess', async () => {
  const identity = freshIdentity();

  for (const label of ['a', 'b', 'c']) {
    await identity.verify({
      proof: BAD_PROOF,
      nonce: nonceFor(label),
      sessionId: `s-${label}`,
      source: '198.51.100.7',
    });
  }

  // The locked address keeps trying, this time with the real password.
  const nonce = nonceFor('e');
  const proof = await computeProof(identity.password, nonce, identity.code, 's-e');
  assert.equal(
    await identity.verify({ proof, nonce, sessionId: 's-e', source: '198.51.100.7' }),
    false,
    'a lockout that a correct password walks through is not a lockout',
  );
});
