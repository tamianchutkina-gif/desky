# Shipping the agent to a client's Mac

How the agent is built, why it is signed the way it is, and why clients
install it with one command rather than by downloading a `.dmg`. Most of
this page exists because macOS Gatekeeper, ad-hoc signatures and quarantine
interact in ways that are documented nowhere in one place.

## Building

Bake your server address in, so the client has nothing to type:

```bash
DESKY_SERVER=wss://desky.example.com/signal npm run host:pack
```

Installers:

```bash
npm run dist:mac --workspace=@desky/host
```

Output lands in `packages/host/release/`.

The app icon can be regenerated from code when needed:

```bash
npm run icon --workspace=@desky/host
```

### Signing on macOS

Builds are ad-hoc signed automatically (`packages/host/build/adhoc-sign.cjs`,
run as electron-builder's `afterPack`). This is not optional decoration. Left
to itself electron-builder finds no identity and skips signing entirely, and
the bundle keeps the linker's signature from the Electron binary it was built
from — a signature that declares sealed resources the finished app does not
have. macOS reads that as broken rather than absent and refuses to launch the
app at all, with a dead-end dialog saying it cannot be opened and a single OK.
On Apple Silicon there is no way past it: arm64 code must carry a valid
signature to run, and ad-hoc counts.

One file covers every Mac:

```bash
DESKY_SERVER=wss://desky.example.com/signal npm run dist:mac:universal
```

That produces a single universal `.dmg` and deletes everything else the
build emits, because a universal bundle is merged with `lipo` and the
per-architecture bundles it is merged from are left unsigned on purpose
— shipping one of those gives the client an app that will not open at
all. The signing step checks every nested binary and fails the build
rather than let that out.

**Without a Developer ID, permissions reset on every rebuild.** macOS ties
Screen Recording and Accessibility to an app's code signature, and an
ad-hoc-signed build gets a new one each time it is built. The client would have
to grant both permissions again after every update — which, in practice, means
they stop updating.

Without signing and notarization macOS blocks the client's first launch
altogether when the app arrived through a browser or a messenger — see
below. Working with clients regularly needs an Apple Developer ID:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
npm run dist:mac --workspace=@desky/host
```

### Getting it onto a client's Mac

Publish the build once, and clients install with one line:

```bash
./scripts/publish-mac.sh root@203.0.113.10 desky.example.com
```

That uploads the universal `.zip` to `/opt/desky/downloads`, which the
signaling server hands out at `/download`, and checks over HTTPS that
what is served is byte-for-byte what was uploaded. The client then gets
either a page to open

    https://desky.example.com/install

or the one line printed on it, which is the whole installation:

```bash
curl -fsSL https://desky.example.com/install.sh | bash
```

It downloads the agent, checks the checksum, checks that the bundle's
ad-hoc signature is intact (integrity, not identity — see below),
puts it in `/Applications` and starts it.

**Why a command and not "download the .dmg and drag it in".** Anything a
browser, Telegram, Mail or AirDrop hands over carries
`com.apple.quarantine`, and Gatekeeper assesses every quarantined bundle.
An ad-hoc signature is a valid signature but not a traceable one, so the
assessment fails. `curl` sets no quarantine attribute; fetched that way
the bundle is never assessed, the ad-hoc signature satisfies the kernel,
and the app opens with no dialog at all.

This is a workaround for the missing Developer ID, not a replacement for
one. The signature still changes on every build, so Screen Recording and
Accessibility still have to be granted again after each update.

### If a client downloads the .dmg anyway

Worth knowing precisely, because it is the step where a non-technical
person gives up — and because the wording changed in recent macOS.

A quarantined ad-hoc-signed bundle is refused on the first double-click.
Depending on the release and on how the file arrived, that is either

> **"Desky" Not Opened.** Apple could not verify "Desky" is free of
> malware that may harm your Mac or compromise your privacy.

with a Done button and, afterwards, an **Open Anyway** line in System
Settings → Privacy & Security — or the harder one,

> **Не удается открыть программу «Desky».**

with a single OK and nothing in System Settings to clear it. There is no
way through the second from the Finder. **Ctrl-clicking and choosing
Open does not get past either on macOS 15 (Sequoia) or later** — that
route was removed, and it is still the advice in most write-ups, which
is why people conclude the app is broken.

From a terminal, one command clears it:

```bash
xattr -dr com.apple.quarantine /Applications/Desky.app
```

Which is the same thing `install.sh` avoids ever needing. Send the
install link instead.

You can check what a build will do before sending it:

```bash
spctl -a -vvv -t install packages/host/release/mac-universal/Desky.app
```

A verdict of `rejected` is expected and is not a broken build: it is
Gatekeeper saying there is no Developer ID behind the signature, which
is exactly why clients install with `curl` rather than by downloading.


`accepted` means the client sees nothing. `rejected` means they meet the
dialog above.

## What the client has to grant on macOS

Two system permissions, both granted once:

- **Screen Recording** — required. Without it there is nothing to connect to.
  The agent restarts after it is enabled; that is a macOS requirement.
- **Accessibility** — optional. Without it the session still runs, but
  **view-only**: you see the screen and talk them through it while they do the
  clicking. Both sides are told this is the case.

The agent walks the client through it and opens the right settings pane
itself. Nobody can grant these on their behalf — that is a macOS restriction.

Without both, the session still runs — view-only if Accessibility is missing,
not at all if Screen Recording is. The panel says which one is missing and
opens the right pane of System Settings itself.
