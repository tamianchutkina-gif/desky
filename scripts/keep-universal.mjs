import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeps only the universal build, and only if it is properly signed.
 *
 * A universal bundle is merged from an x64 and an arm64 one, and the
 * merge refuses to run unless every non-binary file in the two matches
 * byte for byte — which signing them separately breaks. So build/adhoc-
 * sign.cjs leaves the slices unsigned during a universal build and signs
 * only the merged result.
 *
 * The catch is that electron-builder still wraps those unsigned slices
 * into their own .dmg files, and an unsigned bundle is the one failure
 * a client cannot get past: macOS says the app "cannot be opened" and
 * offers a single OK, with no Open Anyway anywhere. Shipping one of
 * those by mistake costs a support call and looks like the app is
 * broken. So they are deleted here rather than left lying beside the
 * good one.
 */

const release = path.join(import.meta.dirname, '..', 'packages', 'host', 'release');
const isUniversal = (name) => name.includes('universal');

const app = path.join(release, 'mac-universal', 'Desky.app');
if (!fs.existsSync(app)) {
  console.error('[keep-universal] no universal bundle was built');
  process.exit(1);
}

// An invalid signature must fail the build, not ship: this is the exact
// defect the slices carry, and the whole point of the check.
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

let removed = 0;
for (const entry of fs.readdirSync(release, { withFileTypes: true })) {
  if (isUniversal(entry.name)) continue;
  if (entry.isDirectory() && !entry.name.startsWith('mac')) continue;
  if (!entry.isDirectory() && !/\.(dmg|zip|blockmap)$/.test(entry.name)) continue;
  fs.rmSync(path.join(release, entry.name), { recursive: true, force: true });
  removed += 1;
}

console.log(`  • kept the signed universal build, removed ${removed} unsigned artefact(s)`);
