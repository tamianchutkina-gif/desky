#!/usr/bin/env bash
#
# Publishes the packaged macOS agent so clients can install it.
#
#   scripts/publish-mac.sh root@203.0.113.10 desky.example.com
#
# Build it first, with the server address baked in:
#
#   DESKY_SERVER=wss://desky.example.com/signal npm run dist:mac:universal
#
# The archive is uploaded to $REMOTE_DIR/downloads, which the signaling
# container serves read-only at /download. A client then installs with
# the one line printed at the end.
#
# The .zip is published rather than the .dmg. Both contain the same
# bundle, but a .zip is unpacked with ditto, which preserves the
# symlinks, permissions and extended attributes an app's code signature
# is sealed over. Mounting a disk image from a script means hdiutil and
# a cleanup path for the mount, for no gain.

set -euo pipefail

TARGET="${1:-}"
DOMAIN="${2:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/desky}"
SERVICE_USER="${SERVICE_USER:-desky}"

if [ -z "$TARGET" ] || [ -z "$DOMAIN" ]; then
  cat >&2 <<USAGE
usage: scripts/publish-mac.sh <ssh-target> <domain>

  ssh-target   what you would type after "ssh", e.g. root@203.0.113.10 or an ssh alias
  domain       the deployment it is being published to
USAGE
  exit 2
fi

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

RELEASE="packages/host/release"
APP="$RELEASE/mac-universal/Desky.app"

# ---------------------------------------------------------------------
say "1/5  Checking the build"

ARCHIVE=$(ls -1 "$RELEASE"/*universal-mac.zip 2>/dev/null | head -1 || true)
if [ -z "$ARCHIVE" ]; then
  cat >&2 <<MISSING
No universal build found in $RELEASE.

Build one first — the server address is baked in at build time, so it
has to be set here and not only at runtime:

  DESKY_SERVER=wss://$DOMAIN/signal npm run dist:mac:universal
MISSING
  exit 1
fi
echo "     $(basename "$ARCHIVE")  ($(du -h "$ARCHIVE" | cut -f1))"

# An agent that cannot find the server is indistinguishable, to the
# client, from an agent that does not work. Checking it here costs a
# second; finding out from a client who has already installed it costs
# the call.
# Read out of the packed archive rather than out of src/, because what
# matters is the address inside the bundle about to be shipped, not the
# one the working tree happens to hold now.
BAKED=$(node -e "
  const fs = require('node:fs');
  const asar = fs.readFileSync(process.argv[1]).toString('latin1');
  // The key, not just any wss:// in the archive — the first bare match
  // is the example address in a doc comment, which would pass or fail
  // this check for reasons that have nothing to do with the build.
  const m = asar.match(/\"defaultServerUrl\"\s*:\s*\"([^\"]+)\"/);
  process.stdout.write(m ? m[1] : '');
" "$APP/Contents/Resources/app.asar" 2>/dev/null || true)
if [ -n "$BAKED" ]; then
  echo "     baked server address: $BAKED"
  case "$BAKED" in
    *"$DOMAIN"*) ;;
    *)
      echo "" >&2
      echo "That build points at $BAKED, not at $DOMAIN." >&2
      echo "Rebuild with DESKY_SERVER=wss://$DOMAIN/signal before publishing." >&2
      exit 1
      ;;
  esac
fi

# The installer refuses to install a bundle that does not verify, so a
# broken archive would simply fail on every client. Fail here instead.
codesign --verify --deep --strict "$APP" 2>/dev/null || {
  echo "The built app is not correctly signed; publishing it would install nothing." >&2
  exit 1
}
echo "     signature ok"

# ---------------------------------------------------------------------
say "2/5  Checksum"

SUM=$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)
echo "     $SUM"

# ---------------------------------------------------------------------
say "3/5  Uploading to $TARGET"

SUDO=$(ssh "$TARGET" '[ "$(id -u)" = 0 ] && echo "" || echo sudo')

# Staged through /tmp because $REMOTE_DIR is mode 750 and owned by the
# service account: the deploying account cannot write into it, and scp
# has no way to gain privilege on the far side. mktemp on the far side,
# not a name built from this shell's pid: a predictable path in a shared
# /tmp is a symlink waiting to happen.
STAGE=$(ssh "$TARGET" 'mktemp /tmp/desky-publish.XXXXXXXX')
scp -q "$ARCHIVE" "$TARGET:$STAGE"
echo "     uploaded"

# ---------------------------------------------------------------------
say "4/5  Installing it on the server"

ssh "$TARGET" "
  set -e
  DEST=$REMOTE_DIR/downloads
  $SUDO mkdir -p \$DEST

  # Written under a temporary name and moved into place, so a client
  # downloading while this runs gets the old file whole rather than the
  # new one half-written.
  $SUDO mv $STAGE \$DEST/.Desky-mac.zip.incoming
  $SUDO mv \$DEST/.Desky-mac.zip.incoming \$DEST/Desky-mac.zip
  printf '%s  Desky-mac.zip\n' '$SUM' | $SUDO tee \$DEST/Desky-mac.zip.sha256 >/dev/null

  $SUDO chown -R $SERVICE_USER:$SERVICE_USER \$DEST
  $SUDO chmod 755 \$DEST
  $SUDO chmod 644 \$DEST/Desky-mac.zip \$DEST/Desky-mac.zip.sha256
  echo \"     \$($SUDO du -h \$DEST/Desky-mac.zip | cut -f1) in place\"
"

# ---------------------------------------------------------------------
say "5/5  Checking it from the outside"

# The end-to-end check that matters: the bytes a client's curl will get,
# and the checksum their installer will compare against.
REMOTE_SUM=$(curl -fsSL "https://$DOMAIN/download/Desky-mac.zip.sha256" | cut -d' ' -f1 || true)
if [ "$REMOTE_SUM" != "$SUM" ]; then
  echo "The published checksum does not match what was uploaded." >&2
  echo "  expected $SUM" >&2
  echo "  served   ${REMOTE_SUM:-(nothing)}" >&2
  exit 1
fi

# Then the archive itself, hashed as it comes off the wire. A header
# check would only prove the length; the promise to the client is that
# the bytes they download are the bytes that were built here.
SERVED_SUM=$(curl -fsSL --proto '=https' "https://$DOMAIN/download/Desky-mac.zip" | shasum -a 256 | cut -d' ' -f1)
[ "$SERVED_SUM" = "$SUM" ] || {
  echo "The archive the server serves does not hash to what was uploaded." >&2
  echo "  expected $SUM" >&2
  echo "  served   ${SERVED_SUM:-(nothing)}" >&2
  exit 1
}
echo "     served archive hashes to the uploaded checksum"

curl -fsSL "https://$DOMAIN/install.sh" | head -1 | grep -q '^#!/bin/bash' || {
  echo "https://$DOMAIN/install.sh is not serving the installer." >&2
  exit 1
}
echo "     installer script is live"

cat <<DONE

  Published.

  Send a client this page:

      https://$DOMAIN/install

  Or the command on it, which is the whole installation:

      curl -fsSL https://$DOMAIN/install.sh | bash

DONE
