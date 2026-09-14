#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the shared protocol, stylesheet and fonts into the agent.
 *
 * The agent is packaged into an app bundle that cannot reach up out of
 * its own directory, so the files it shares with the server have to sit
 * inside it. Copying rather than symlinking keeps electron-builder and
 * Windows happy.
 *
 * Run automatically before starting or packaging the agent.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const HOST = path.join(ROOT, 'packages/host');
const PUBLIC = path.join(ROOT, 'packages/server/public');

const copies = [
  [path.join(ROOT, 'shared/protocol.js'), path.join(HOST, 'shared/protocol.js')],
  [path.join(ROOT, 'shared/desky.css'), path.join(HOST, 'shared/desky.css')],
  [path.join(PUBLIC, 'fonts.css'), path.join(HOST, 'renderer/fonts.css')],
];

for (const [from, to] of copies) {
  if (!fs.existsSync(from)) {
    console.error(`[sync] missing ${path.relative(ROOT, from)}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

const fontsFrom = path.join(PUBLIC, 'fonts');
const fontsTo = path.join(HOST, 'renderer/fonts');
if (fs.existsSync(fontsFrom)) {
  fs.mkdirSync(fontsTo, { recursive: true });
  for (const file of fs.readdirSync(fontsFrom)) {
    fs.copyFileSync(path.join(fontsFrom, file), path.join(fontsTo, file));
  }
}

/**
 * Bakes the server address into the build.
 *
 * The agent reads DESKY_SERVER from the environment when developing,
 * but a client double-clicks an icon and has no environment to speak
 * of. Writing the address here at build time is what lets
 *
 *   DESKY_SERVER=wss://desky.example.com/signal npm run host:pack
 *
 * produce an installer that connects to the right server with nothing
 * for the client to type.
 */
const buildConfigPath = path.join(HOST, 'src/build-config.json');
const bakedServer = process.env.DESKY_SERVER?.trim();

if (bakedServer) {
  fs.writeFileSync(buildConfigPath, `${JSON.stringify({ defaultServerUrl: bakedServer }, null, 2)}\n`);
  console.log(`[sync] server address baked into the build: ${bakedServer}`);
} else if (!fs.existsSync(buildConfigPath)) {
  // An empty file keeps the import in config.js unconditional.
  fs.writeFileSync(buildConfigPath, `${JSON.stringify({ defaultServerUrl: null }, null, 2)}\n`);
}

const fontCount = fs.existsSync(fontsFrom) ? fs.readdirSync(fontsFrom).length : 0;
console.log(`[sync] files updated: ${copies.length + fontCount}`);
