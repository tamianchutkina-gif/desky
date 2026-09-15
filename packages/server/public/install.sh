#!/bin/bash
#
# Installs the Desky agent on a client's Mac.
#
#   curl -fsSL https://desky.example.com/install.sh | bash
#
# Why this exists, rather than "download the disk image and drag it in".
#
# The agent is signed ad-hoc: there is no Developer ID behind it and
# nothing is notarised. That signature is enough for dyld and AMFI, so
# the code runs — but Gatekeeper assesses any bundle carrying
# com.apple.quarantine and rejects one it cannot trace to a developer.
# A browser, Telegram, Mail and AirDrop all set that attribute on what
# they hand over. So a client who downloads the .dmg meets a dialog
# saying the application cannot be opened, with a single OK: on macOS 15
# the Control-click bypass is gone, and an ad-hoc signature earns no
# "Open Anyway" in System Settings either. It is a dead end, and it
# looks exactly like a broken app.
#
# curl sets no quarantine attribute. Fetched this way the bundle is
# never assessed, the ad-hoc signature satisfies the kernel, and the app
# opens with no dialog at all. That is the whole trick.
#
# It stands in for a Developer ID; it does not replace one. The
# signature still changes on every build, so Screen Recording and
# Accessibility are granted again after each update.

set -euo pipefail

# Rewritten by the server from the request's own host, so a copy of this
# script always points back at the deployment that served it.
ORIGIN="${DESKY_ORIGIN:-__DESKY_ORIGIN__}"

ARCHIVE_URL="$ORIGIN/download/Desky-mac.zip"
APP="/Applications/Desky.app"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; off=$'\033[0m'
say()  { printf '%s\n' "  $*"; }
step() { printf '\n%s%s%s\n' "$bold" "$*" "$off"; }
die()  { printf '\n%sCould not install Desky.%s\n  %s\n\n' "$red$bold" "$off" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------
printf '\n%sDesky%s %s— installing the support agent%s\n' "$bold" "$off" "$dim" "$off"

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. This machine reports $(uname -s)."

# 13 (Ventura) is the oldest release the packaged Electron runtime
# supports; below it the app installs and then refuses to launch, which
# is the failure this whole script exists to avoid.
MAJOR=$(sw_vers -productVersion | cut -d. -f1)
[ "$MAJOR" -ge 13 ] 2>/dev/null || die "Desky needs macOS 13 or newer. This machine has $(sw_vers -productVersion)."

# Everything lands here first and is checked before anything in
# /Applications is touched, so a failed download cannot leave the client
# with a half-replaced app and no working one.
WORK=$(mktemp -d /tmp/desky-install.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------
step "1/4  Downloading"

# --proto '=https': the archive URL is built from this script's own
# origin, and a redirect to plain http on the way would otherwise be
# followed without a word.
curl -fL --proto '=https' --tlsv1.2 --progress-bar "$ARCHIVE_URL" -o "$WORK/Desky.zip" \
  || die "Could not download from $ARCHIVE_URL"

# The checksum is fetched rather than pinned in this file: the script is
# served from the same origin as the archive, so pinning would add no
# authority it does not already have. What it does catch is a truncated
# or corrupted transfer, which is the realistic failure over a home
# connection and is otherwise met later as an unexplained crash. A
# missing checksum file is a failure, not a pass: an installer that
# skips its only integrity check when the check is unavailable has no
# integrity check.
curl -fsSL --proto '=https' --tlsv1.2 "$ARCHIVE_URL.sha256" -o "$WORK/Desky.zip.sha256" \
  || die "Could not download the checksum from $ARCHIVE_URL.sha256"
EXPECTED=$(cut -d' ' -f1 <"$WORK/Desky.zip.sha256")
ACTUAL=$(shasum -a 256 "$WORK/Desky.zip" | cut -d' ' -f1)
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || die "The download is damaged. Run the command again."
say "checksum ok"

# ---------------------------------------------------------------------
step "2/4  Unpacking"

# ditto, not unzip: it is the tool that preserves symlinks, the
# executable bits and the extended attributes a signed .app is sealed
# with. unzip flattens enough of that to invalidate the signature, and
# an invalidated signature is the dead-end dialog again.
ditto -x -k "$WORK/Desky.zip" "$WORK/unpacked" || die "Could not unpack the download."

NEW="$WORK/unpacked/Desky.app"
[ -d "$NEW" ] || die "The download did not contain Desky.app."

# Verified before installing, not after. A bundle whose signature is
# broken will not launch, and finding that out while the client's old
# copy is already deleted is the worst moment to find it out.
codesign --verify --deep --strict "$NEW" 2>/dev/null \
  || die "The downloaded app is not correctly signed. Nothing was installed."
say "signature ok"

# ---------------------------------------------------------------------
step "3/4  Installing"

# A running copy holds its own files open, and replacing them underneath
# it leaves a process running code that is no longer on disk.
if pgrep -x Desky >/dev/null 2>&1; then
  osascript -e 'quit app "Desky"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x Desky >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -x Desky >/dev/null 2>&1 || true
  say "closed the running copy"
fi

# /Applications is writable by the admin group, which covers the ordinary
# case. When it is not — a managed Mac, a standard account — sudo asks
# for a password on the terminal rather than failing halfway through.
AS=""
if [ ! -w /Applications ]; then
  say "/Applications needs an administrator; you will be asked for your password"
  AS="sudo"
fi

$AS rm -rf "$APP"
$AS ditto "$NEW" "$APP" || die "Could not copy Desky into /Applications."

# Belt and braces. Nothing above should have set it — curl does not, and
# ditto does not invent one — but a single quarantined bundle is the
# entire failure this script exists to prevent, so it is cleared rather
# than assumed absent.
$AS xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

codesign --verify --deep --strict "$APP" 2>/dev/null \
  || die "The installed copy did not verify. Run the command again."

# ---------------------------------------------------------------------
step "4/4  Starting Desky"

open -a "$APP" || die "Installed, but could not start it. Open Desky from Applications."

cat <<'DONE'

  Desky is installed and running.

  It will ask for two macOS permissions the first time:

    Screen Recording      required — without it there is nothing to share
    Accessibility         optional — without it the session is view-only

  Both are granted in System Settings, under Privacy & Security. Desky
  opens the right pane for you. macOS asks you to quit and reopen the
  app after granting them, which Desky also offers to do.

  Then read the computer number out to whoever is helping you, and wait
  for the request to appear. Nothing happens on your screen until you
  press Allow.

DONE
