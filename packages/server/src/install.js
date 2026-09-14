import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from './config.js';
import { CSP } from './static.js';

/**
 * The client-facing installer: a page and the script it hands out.
 *
 * Both are ordinary files in `public/`, and both would be served by the
 * static handler untouched — which is exactly what must not happen.
 * Each carries the address of the deployment it came from: the page
 * shows the command to paste, the script fetches the archive. Baking
 * that address into the repository would tie the files to one
 * deployment and quietly break every other one, and a wrong address in
 * a script a client pastes into a terminal is not a failure anyone
 * wants to debug over the phone.
 *
 * So the origin is filled in here, from the request's own host. A copy
 * of the script always points back at the server that served it, and
 * nothing in the repository has to know where it is deployed.
 *
 * These paths are claimed before the static handler runs, so the
 * unsubstituted originals are never reachable.
 */

const PLACEHOLDER = /__DESKY_ORIGIN__/g;

const ROUTES = new Map([
  ['/install', { file: 'install.html', type: 'text/html; charset=utf-8', csp: true }],
  ['/install.html', { file: 'install.html', type: 'text/html; charset=utf-8', csp: true }],
  // Served as plain text rather than as a shell type: a browser should
  // show a client what they are about to run, not offer to download it.
  ['/install.sh', { file: 'install.sh', type: 'text/plain; charset=utf-8', csp: false }],
]);

/**
 * The address this request arrived on.
 *
 * `url.host` has already been through the URL parser in index.js, so it
 * is a syntactically valid host and not whatever a caller felt like
 * sending. The scheme is the part that cannot be observed from inside a
 * container behind a proxy, so it is read from the proxy's own header —
 * and only when this deployment is configured to trust one, and only
 * when it says something a scheme may say.
 */
function originOf(req, url, trustProxy) {
  let scheme = 'http';
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-proto'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0].trim().toLowerCase();
      if (first === 'https' || first === 'http') scheme = first;
    }
  }
  return `${scheme}://${url.host}`;
}

export function createInstallHandler({ trustProxy = false } = {}) {
  const dir = path.join(ROOT, 'public');

  return async function serveInstall(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const route = ROUTES.get(url.pathname);
    if (!route) return false;

    const source = await fsp.readFile(path.join(dir, route.file), 'utf8');
    const body = source.replace(PLACEHOLDER, originOf(req, url, trustProxy));

    res.writeHead(200, {
      'Content-Type': route.type,
      'Content-Length': Buffer.byteLength(body),
      ...(route.csp ? { 'Content-Security-Policy': CSP } : {}),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // Rewritten per request and per deployment, and the one thing a
      // client is told to run. A stale copy from a proxy pointing at a
      // previous address is worse than a second round trip.
      'Cache-Control': 'no-store',
    });

    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
