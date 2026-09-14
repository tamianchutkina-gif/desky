import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServerUrl } from '../packages/host/src/config.js';

/**
 * The agent's server address.
 *
 * Everything that decides whether a stranger gets onto someone's machine
 * crosses this socket: the nonce, the operator's proof of the session
 * password, and the fingerprint signatures that are the only defence
 * against a server sitting in the middle. In plaintext all of it is
 * readable, and the proof is what an offline search runs against — so a
 * plaintext address is refused rather than accepted quietly, which is
 * what typing `http://` used to do.
 */

test('a secure address is kept', () => {
  assert.equal(normalizeServerUrl('wss://desky.example.com/signal'), 'wss://desky.example.com/signal');
});

test('https is understood as wss', () => {
  assert.equal(normalizeServerUrl('https://desky.example.com'), 'wss://desky.example.com/signal');
});

test('a bare hostname is assumed to be secure', () => {
  assert.equal(normalizeServerUrl('desky.example.com'), 'wss://desky.example.com/signal');
});

test('a missing path becomes /signal', () => {
  assert.equal(normalizeServerUrl('wss://desky.example.com'), 'wss://desky.example.com/signal');
  assert.equal(normalizeServerUrl('wss://desky.example.com/'), 'wss://desky.example.com/signal');
});

test('a path that was given is left alone', () => {
  assert.equal(normalizeServerUrl('wss://desky.example.com/socket'), 'wss://desky.example.com/socket');
});

test('a plaintext address over the network is refused', () => {
  // Refused, not downgraded. The panel says why; it does not connect.
  assert.equal(normalizeServerUrl('ws://desky.example.com/signal'), null);
  assert.equal(normalizeServerUrl('http://desky.example.com'), null);
  assert.equal(normalizeServerUrl('ws://192.168.1.10:8080/signal'), null);
});

test('plaintext to loopback is allowed, because there is no network to listen on', () => {
  assert.equal(normalizeServerUrl('ws://localhost:8080/signal'), 'ws://localhost:8080/signal');
  assert.equal(normalizeServerUrl('http://localhost:8080'), 'ws://localhost:8080/signal');
  assert.equal(normalizeServerUrl('ws://127.0.0.1:8080/signal'), 'ws://127.0.0.1:8080/signal');
  assert.equal(normalizeServerUrl('ws://[::1]:8080/signal'), 'ws://[::1]:8080/signal');
});

test('anything that is not a websocket address is refused', () => {
  for (const value of ['ftp://desky.example.com', 'file:///etc/passwd', 'not a url', 'javascript:alert(1)']) {
    assert.equal(normalizeServerUrl(value), null, `${value} should be refused`);
  }
});

test('an empty address falls back to the one baked into the build', () => {
  const fallback = normalizeServerUrl('');
  assert.ok(fallback);
  assert.match(fallback, /^wss?:\/\//);
  assert.equal(normalizeServerUrl('   '), fallback);
  assert.equal(normalizeServerUrl(null), fallback);
});
