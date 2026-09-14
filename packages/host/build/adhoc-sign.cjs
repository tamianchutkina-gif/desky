const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Signs the packaged app with an ad-hoc signature, inside out.
 *
 * Without a Developer ID, electron-builder finds no identity and skips
 * signing altogether — and skipping is worse than not signing. The app
 * keeps the linker's own signature from the Electron binary it was built
 * from, which declares sealed resources that the finished bundle does not
 * have. macOS reads that as a broken signature rather than an absent one
 * and refuses to launch the app at all:
 *
 *   codesign --verify: code has no resources but signature indicates
 *                      they must be present
 *
 * What the client sees is a dialog saying the application cannot be
 * opened, with a single OK and no way past it — not the familiar
 * unidentified-developer warning that "Open Anyway" clears. On Apple
 * Silicon there is no way around it either: arm64 code must carry a valid
 * signature to run, even an ad-hoc one.
 *
 * `--deep` is not enough, and the reason cost a day. A universal build is
 * merged with lipo, which writes fresh Mach-O files and drops whatever
 * signatures they arrived with. `--deep` then re-signs the bundle and the
 * nested bundles, but not a .dylib inside a framework's Libraries folder
 * and not a .node under app.asar.unpacked — to codesign those are sealed
 * resources, not code. The bundle verifies clean while dyld still refuses
 * to load the unsigned libraries, which on Apple Silicon is fatal and
 * surfaces as exactly the dead-end dialog above.
 *
 * So every Mach-O file is signed individually, deepest path first, and
 * the bundle last. Then the result is verified file by file, because a
 * passing `codesign --verify --deep --strict` demonstrably does not mean
 * the app will start.
 *
 * This is not a substitute for a Developer ID, and it does less than it
 * once said here. It is the difference between an app that cannot start
 * at all and one that can — it does nothing about Gatekeeper. A bundle
 * that reaches a client through a browser, a messenger or AirDrop
 * carries com.apple.quarantine and is assessed, and an ad-hoc signature
 * is valid but not traceable to a developer, so the assessment fails and
 * the client meets the dead-end dialog again for a different reason. The
 * way past that is not to sign harder: clients install with
 * `curl | bash` from packages/server/public/install.sh, because curl
 * sets no quarantine attribute and an unassessed bundle launches on this
 * signature alone.
 *
 * The signature also still changes on every build, which is what resets
 * Screen Recording and Accessibility.
 */

const NESTED_BUNDLE = /\.(app|framework|xpc|bundle)$/;

/** Mach-O magic numbers, thin and fat, both byte orders. */
const MACH_O_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACH_O_MAGIC.has(head.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Every Mach-O file and every nested bundle, deepest path first. */
function collectTargets(root) {
  const targets = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (NESTED_BUNDLE.test(entry.name)) targets.push(full);
        walk(full);
      } else if (entry.isFile() && isMachO(full)) {
        targets.push(full);
      }
    }
  };

  walk(root);
  return targets.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A universal build is merged from an x64 and an arm64 bundle, and the
  // merge refuses to run unless every non-binary file in the two matches
  // byte for byte — which signing them separately breaks. Sign only the
  // merged result; scripts/keep-universal.mjs deletes the unsigned
  // slices so neither can be shipped by mistake.
  if (process.argv.includes('--universal') && !context.appOutDir.endsWith('mac-universal')) {
    return;
  }

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  const targets = collectTargets(app);
  for (const target of targets) sign(target);
  sign(app);

  // Verify the whole bundle, then every nested Mach-O on its own. The
  // second half is the one that matters: the first passes even when the
  // app cannot start.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

  const unsigned = targets.filter((target) => {
    try {
      execFileSync('codesign', ['--verify', target], { stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  });

  if (unsigned.length > 0) {
    for (const target of unsigned) {
      console.error(`  ✗ unsigned: ${path.relative(app, target)}`);
    }
    throw new Error(
      `${unsigned.length} nested binaries are unsigned — the app would not launch`,
    );
  }

  console.log(`  • ad-hoc signed  ${path.basename(app)} (${targets.length} nested objects)`);
};
