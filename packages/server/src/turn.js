import { createHmac } from 'node:crypto';

import { config } from './config.js';

/**
 * Builds the ICE server list handed to both peers when a session opens.
 *
 * TURN credentials are ephemeral: coturn's REST-API scheme takes a
 * username of `<expiry-unix-ts>:<label>` and a password that is
 * HMAC-SHA1 of that username under a shared secret. Nothing long-lived
 * is ever shipped to a browser, so a leaked console session cannot be
 * turned into a permanent relay account.
 */
export function iceServersFor(label) {
  const servers = [];

  // coturn answers STUN on the same port it relays on, so a deployment
  // that has a relay already has a STUN server — its own. Using it means
  // no third party is told when a session starts, and discovery keeps
  // working on networks where the public STUN servers are blocked or
  // slow, which is common on corporate and some national networks.
  //
  // The public fallback is for a stack brought up without a relay, where
  // there would otherwise be no way to discover a public address at all.
  const stunUrls = config.turnHost
    ? [`stun:${config.turnHost}:${config.turnPort}`]
    : [...config.stunFallbackUrls];

  stunUrls.push(...config.stunUrls);
  if (stunUrls.length > 0) servers.push({ urls: stunUrls });

  if (config.turnSecret && config.turnHost) {
    const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
    const username = `${expiry}:${sanitize(label)}`;
    const credential = createHmac('sha1', config.turnSecret)
      .update(username)
      .digest('base64');

    const urls = [
      `turn:${config.turnHost}:${config.turnPort}?transport=udp`,
      `turn:${config.turnHost}:${config.turnPort}?transport=tcp`,
    ];

    // TLS relaying is only advertised when coturn has actually been
    // given a certificate. Offering `turns:` without one hands both
    // peers a candidate that can never complete, and it fails silently
    // in exactly the case the relay exists for: a firewall that permits
    // nothing but TLS out.
    if (config.turnTls) {
      urls.push(`turns:${config.turnHost}:${config.turnTlsPort}?transport=tcp`);
    }

    servers.push({ urls, username, credential });
  }

  return servers;
}

export function turnConfigured() {
  return Boolean(config.turnSecret && config.turnHost);
}

function sanitize(label) {
  return String(label ?? 'peer').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'peer';
}
