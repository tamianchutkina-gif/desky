import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Content policy for the operator console.
 *
 * The console is a control surface for other people's machines, so it
 * loads nothing it did not ship with: no third-party scripts, no
 * inline scripts, no external stylesheets or fonts.
 *
 * WebRTC is not governed by connect-src, so media and input are
 * unaffected; `ws:`/`wss:` is here for the signaling socket, and
 * `data:` for the inline SVG favicon.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  // The macOS agent, and the checksum the installer verifies it
  // against before it replaces anything in /Applications.
  '.zip': 'application/zip',
  '.sha256': 'text/plain; charset=utf-8',
};

/**
 * Minimal static file handler for the operator console.
 *
 * Written by hand rather than pulled in as a dependency: the console is
 * a handful of files, and a server that a support engineer has to trust
 * with access to their clients' machines is one whose dependency list
 * should stay short enough to actually read.
 */
export function createStaticHandler(mounts) {
  const resolved = mounts.map(({ prefix, dir }) => ({
    prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
    dir: path.resolve(dir),
  }));

  return async function serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    for (const mount of resolved) {
      if (!url.pathname.startsWith(mount.prefix) && url.pathname !== mount.prefix.slice(0, -1)) {
        continue;
      }

      let relative = url.pathname.slice(mount.prefix.length);
      if (relative === '' || relative.endsWith('/')) relative += 'index.html';

      const target = path.resolve(mount.dir, relative);

      // Reject anything that escapes the mount root. Without this a
      // request for /../../.env walks straight out of the public dir.
      if (target !== mount.dir && !target.startsWith(mount.dir + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return true;
      }

      try {
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) continue;

        const ext = path.extname(target).toLowerCase();
        const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304).end();
          return true;
        }

        res.writeHead(200, {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          'Content-Length': stat.size,
          ETag: etag,
          ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}),
          // The console is a control surface for other people's
          // machines; it must never be embedded in a third-party page.
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          // Scripts and styles revalidate on every load: their names carry
          // no hash, and a five-minute cache meant that for five minutes
          // after a deploy a console could run the new protocol.js against
          // the old console.js. Fonts change rarely and are large, so
          // they may be kept for a day.
          'Cache-Control': ext === '.woff2' && process.env.NODE_ENV === 'production'
            ? 'public, max-age=86400'
            : 'no-cache',
        });

        if (req.method === 'HEAD') {
          res.end();
          return true;
        }

        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(target);
          stream.on('error', reject);
          stream.on('end', resolve);
          // A client that walks away mid-response would otherwise leave
          // this promise pending and the file handle open, one per
          // aborted request.
          res.on('close', () => { stream.destroy(); resolve(); });
          stream.pipe(res);
        });
        return true;
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
        throw err;
      }
    }

    return false;
  };
}
