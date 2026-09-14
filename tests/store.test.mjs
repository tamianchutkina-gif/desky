import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DeviceStore } from '../packages/server/src/store.js';

/**
 * The device registry.
 *
 * Losing this file gives every client a new nine-digit number, which is
 * the one failure a support tool cannot absorb: the client reads out a
 * different id every morning and stops trusting the thing. So the tests
 * here are mostly about what happens when the disk misbehaves.
 */

function freshStore() {
  return new DeviceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-')));
}

function storeInDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-'));
  return { dir, store: new DeviceStore(dir) };
}

const registryText = (dir) => fs.readFileSync(path.join(dir, 'devices.json'), 'utf8');

test('a first registration mints a nine-digit id and a token', () => {
  const store = freshStore();
  const claim = store.claim({ name: 'A laptop', platform: 'darwin' });

  assert.equal(claim.created, true);
  assert.match(claim.code, /^\d{9}$/);
  assert.equal(claim.token.length, 64);
});

test('the right token reclaims the same id', () => {
  const store = freshStore();
  const first = store.claim({ name: 'A laptop', platform: 'darwin' });
  const again = store.claim({ code: first.code, token: first.token, name: 'A laptop' });

  assert.equal(again.code, first.code);
  assert.equal(again.created, false);
});

test('a wrong token never takes over an existing id', () => {
  const store = freshStore();
  const first = store.claim({ name: 'A laptop', platform: 'darwin' });
  const attacker = store.claim({ code: first.code, token: 'f'.repeat(64), name: 'Not the laptop' });

  assert.notEqual(attacker.code, first.code, 'the id must stay with whoever holds its token');
  assert.equal(attacker.created, true);
  assert.equal(store.get(first.code).name, 'A laptop', 'and the original row is untouched');
});

test('verify tells a genuine reclaim from a mint', () => {
  const store = freshStore();
  const claim = store.claim({ name: 'A laptop', platform: 'darwin' });

  assert.equal(store.verify(claim.code, claim.token), true);
  assert.equal(store.verify(claim.code, 'wrong'), false);
  assert.equal(store.verify('000000000', claim.token), false);

  // The hub reads this to decide what to meter, so anything that is not
  // a matching pair of strings has to come back false rather than throw.
  for (const token of [null, undefined, 42, {}, []]) {
    assert.equal(store.verify(claim.code, token), false);
  }
  for (const code of [null, undefined, 42, {}]) {
    assert.equal(store.verify(code, claim.token), false);
  }
});

test('the registry is written for its owner only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-'));
  const store = new DeviceStore(dir);
  store.claim({ name: 'A laptop', platform: 'darwin' });
  store.flush();

  const file = path.join(dir, 'devices.json');
  // Every row holds a token that registers as that client's machine.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file is left behind');
});

test('registrations survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-'));
  const first = new DeviceStore(dir);
  const claim = first.claim({ name: 'A laptop', platform: 'darwin' });
  first.flush();

  const second = new DeviceStore(dir);
  assert.equal(second.verify(claim.code, claim.token), true);
  assert.equal(second.get(claim.code).name, 'A laptop');
});

test('an unreadable registry is kept, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-'));
  const file = path.join(dir, 'devices.json');

  const first = new DeviceStore(dir);
  first.claim({ name: 'A laptop', platform: 'darwin' });
  first.flush();
  const original = fs.readFileSync(file, 'utf8');

  // A half-written file — a full disk, a container killed mid-write.
  fs.writeFileSync(file, original.slice(0, 40));

  const second = new DeviceStore(dir);
  second.claim({ name: 'Another laptop', platform: 'darwin' });
  second.flush();

  // Starting empty and then writing is how a truncated registry becomes
  // a lost one, so the damaged file is moved aside and nothing replaces
  // it until a person has looked.
  assert.equal(fs.existsSync(`${file}.corrupt`), true);
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), original.slice(0, 40));
  assert.equal(fs.existsSync(file), false);
});

test('a missing registry is an ordinary first run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-'));
  const store = new DeviceStore(dir);

  assert.equal(store.size, 0);
  const claim = store.claim({ name: 'A laptop', platform: 'darwin' });
  store.flush();
  assert.equal(fs.existsSync(path.join(dir, 'devices.json')), true);
  assert.equal(store.verify(claim.code, claim.token), true);
});

test('ids do not collide', () => {
  const store = freshStore();
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    codes.add(store.claim({ name: `Machine ${i}`, platform: 'linux' }).code);
  }
  assert.equal(codes.size, 200);
});

test('listing a registry never discloses tokens', () => {
  const store = freshStore();
  store.claim({ name: 'A laptop', platform: 'darwin' });

  for (const row of store.list()) {
    assert.equal('token' in row, false);
  }
});

test('the registry never holds a token it could hand to an impostor', () => {
  const { dir, store } = storeInDir();
  const claim = store.claim({ name: 'A laptop', platform: 'darwin' });
  store.flush();

  assert.ok(!registryText(dir).includes(claim.token),
    'a readable token in this file lets anyone register as any client');
});

test('a registry written before hashing still reclaims its ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desky-store-'));
  const legacy = {
    devices: [{
      code: '123456789',
      token: 'a'.repeat(64),
      name: 'An older laptop',
      platform: 'darwin',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    }],
  };
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify(legacy));

  const store = new DeviceStore(dir);
  assert.equal(store.verify('123456789', 'a'.repeat(64)), true,
    'an agent that has not been touched must keep its number');
  assert.equal(store.verify('123456789', 'b'.repeat(64)), false);

  const again = store.claim({ code: '123456789', token: 'a'.repeat(64), name: 'An older laptop' });
  assert.equal(again.created, false);
  assert.equal(again.code, '123456789');

  store.flush();
  assert.ok(!registryText(dir).includes('a'.repeat(64)),
    'the plaintext token must be gone once the file has been rewritten');
});
