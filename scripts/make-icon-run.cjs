// Thin launcher: make-icon.mjs must run inside Electron, not Node.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const script = path.join(__dirname, 'make-icon.mjs');
process.exit(spawnSync(electron, [script], { stdio: 'inherit' }).status ?? 1);
