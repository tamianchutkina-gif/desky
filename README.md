# Desky

[![tests](https://github.com/tamianchutkina-gif/desky/actions/workflows/test.yml/badge.svg)](https://github.com/tamianchutkina-gif/desky/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Remote support: you connect to a client's computer and work on it as if you
were sitting there. The client grants access themselves, sees everything that
happens, and can end the session at any moment.

Self-hosted, which means **no session time limits**. The limits in AnyDesk and
TeamViewer are commercial, not technical — on your own server there is nobody
to impose them.

## How it works

```
   Your browser                 Your VPS                  Client's computer
  ┌────────────┐          ┌──────────────────┐          ┌────────────────┐
  │  Operator  │◀────────▶│ Signaling server │◀────────▶│      Agent     │
  │  console   │          │    + TURN relay  │          │   (Electron)   │
  └─────┬──────┘          └──────────────────┘          └───────┬────────┘
        │                                                       │
        └────────── screen and control, peer-to-peer ───────────┘
                        WebRTC, DTLS-SRTP encryption
```

The server only introduces the two sides. After that, the picture and the
input travel **directly** between your computers. The server never sees the
screen, the keystrokes, or the session password.

The password is checked by the agent on the client's own machine. That alone
is not enough, though: since the server decides whose connection description
reaches whom, it could hand each side its own and sit in the middle. So each
side signs its own DTLS fingerprint with the session password and the other
side verifies that signature. The server has no password, so it cannot forge
one.

The result: compromising the server buys an attacker the ability to break a
connection — not to open, substitute, or watch one.

## What is in here

| Folder | What it is |
|---|---|
| `shared/` | Protocol and stylesheet — the same files for every part |
| `packages/server/` | Signaling server and the operator console |
| `packages/host/` | The agent that gets installed on a client's machine |
| `infra/` | Docker Compose: server, TURN, HTTPS |
| `tests/` | Protocol and handshake tests |

## Running it locally

```bash
npm install
```

Server:

```bash
npm run server
```

Agent, in another terminal:

```bash
DESKY_SERVER=ws://localhost:8080/signal npm run host
```

Open <http://localhost:8080> and enter the number and password from the agent
window.

## Deploying to your own server

You need a VPS with a public IP and a domain whose A record already
points at it.

One command does the whole thing — installs Docker if it is missing,
copies the server side across, writes the settings, opens the firewall,
and waits until the certificate is live:

```bash
npm run deploy root@203.0.113.10 desky.example.com you@example.com
```

It is safe to run again after a change: the device registry and the TURN
secret it generated the first time are kept, because replacing the secret
would cut off the sessions running at that moment.

To do it by hand instead:

```bash
cp infra/.env.example infra/.env
```

Fill in `infra/.env`. All six are required — the stack does not start
without them:

| Variable | What it is |
|---|---|
| `DOMAIN` | Your domain, e.g. `desky.example.com` |
| `ACME_EMAIL` | Address for Let's Encrypt. **Leave the line out entirely if you have none** — Caddy's `email` directive with an empty argument is a config error, and the site never comes up |
| `PUBLIC_IP` | The server's public IP |
| `TURN_SECRET` | Shared secret: `openssl rand -hex 32` |
| `SERVICE_UID` | The unprivileged account every container runs as |
| `SERVICE_GID` | Its group |

Create that account and read its ids back:

```bash
sudo useradd --system --shell /usr/sbin/nologin desky && id -u desky && id -g desky
```

Give coturn the secret in a file rather than on its command line, where
every account on the machine could read it:

```bash
cp infra/coturn/turnserver.conf infra/coturn/turnserver.local.conf
echo "static-auth-secret=$(grep '^TURN_SECRET=' infra/.env | cut -d= -f2-)" >> infra/coturn/turnserver.local.conf
```

Hand the volumes to that account before anything starts. Docker creates
them owned by root, and a volume the containers cannot write is the
failure that costs the most: the device registry stops persisting and
every client gets a new nine-digit number on each restart, while Caddy
cannot save its certificate and asks for a new one until Let's Encrypt
refuses.

```bash
for v in desky-devices desky-caddy-data desky-caddy-config; do
  docker volume create "$v" && docker run --rm -v "$v":/v alpine:3 chown -R "$(id -u desky):$(id -g desky)" /v
done
```

Start it:

```bash
cd infra && docker compose up -d
```

Open on the firewall: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `5349/tcp`,
`24000-24200/udp`.

The console will be at `https://<DOMAIN>`, and agents connect to
`wss://<DOMAIN>/signal`.

## Building the agent for clients

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

It downloads the agent, checks the checksum, verifies the signature,
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

## Security

- Nothing is transmitted until a person at that computer presses Allow.
- During a session the client's screen carries a red frame above every window,
  including fullscreen apps. It cannot be hidden.
- The panel shows who is connected, how long the session has run, and what has
  happened.
- A kill switch, ⌘⌥⇧X, ends the session from inside any application.
- The session password is single-use. It changes after a session, after a
  decline, and after a request expires: once it has been read aloud it does not
  get a second life. Three wrong attempts rotate it and lock the machine for a
  minute, and the client is shown why the password changed.
- The password is never used as a key directly. It is eight characters, and
  the key that signs the proof and the fingerprint bindings is derived from it
  with PBKDF2-SHA-256 over 1.2 million iterations — so guessing it offline,
  which is the one thing a malicious server is in a position to try, costs a
  GPU years rather than a laptop milliseconds. Long enough that the password
  has rotated several times over before the search ends.
- Every handshake is single-use — a captured proof of the password cannot be
  presented twice.
- Every held key is released on disconnect, so the client is never left with a
  modifier stuck down.
- The session log is written on the client's machine and sent nowhere.

There is no unattended access in this project, and none is planned.

## Speed

- Direct peer-to-peer, with the relay used only when no direct path exists.
  The console always shows which one is in use.
- H.264 with hardware encoding, up to 60 fps.
- The bitrate ceiling is raised to 40 Mbit/s. Chromium throttles screen sharing
  to about 2.5 Mbit/s by default, which turns text to mush while scrolling.
- Input travels on its own channel with no retransmission: a lost packet is
  dropped rather than delaying the ones behind it. That is why the pointer does
  not stutter.
- The receive-side jitter buffer is driven to zero.

On a local network this comes out at roughly 3 ms of latency at full screen
resolution.

## Tests

```bash
npm test
```

109 tests: the input codec, the key table, the password proof and the key
stretching under it, the connection signature, the agent's own lockout and
replay defences, the device registry
including what it does with a corrupted file, and the full handshake with its
refusals against a real server — malformed request lines and Host headers
among them, because one of those used to end the process.

## Not built yet

- File transfer
- Session recording
- More than one operator on a machine at the same time
- Screen capture under Wayland (X11 works)
- Unattended access — and it is not planned

## What is verified, and what is not

Verified live on macOS: a real session with a live picture, a direct connection
with no relay, single-digit milliseconds of latency, full 2880×1800
resolution. The server side is deployed and serving: `scripts/deploy.sh` runs
end to end and is idempotent, the console loads over HTTPS with its
certificate and its headers, and the signaling socket connects through it. The frame
around the screen, the client's panel, view-only mode, and building and
launching the packaged app. The DTLS fingerprint signature was checked against
real SDP from Chromium, including rejection of a substituted answer. The
automated tests — 109 at the time of writing — cover the protocol, the input
codec, the password proof, the connection signature, and the full handshake
against a real server.

Also verified live, the hard way — by watching a real person meet the app for
the first time. That session found four defects no test would have caught: the
consent window opened behind other windows and was never seen; the app was
absent from the permission list it told the client to open; the panel kept
saying a permission was missing after it had been granted; and the window
sometimes painted blank on launch. All four are fixed.

Not verified live:

- **A keystroke arriving in an application.** Input now demonstrably reaches
  the injector — it announced itself by taking the agent down, on a call that
  exists only on Windows. That is fixed, and the path from the operator's hand
  to the injector is no longer in question; what has not been watched is a
  character appearing in a window. Worth doing between two machines rather than
  one, where the screen shows itself and nothing can be told apart.

- **A session between two separate machines.** Everything verified so far was a
  machine connecting to itself. Note that the console needs HTTPS or
  `localhost`, so the second machine has to reach a deployed server — a phone
  on the same Wi-Fi cannot stand in for it.

- **A relayed session.** The relay is deployed and running on a public
  address, and the signaling server hands out credentials for it
  (`"turn":true` in `/healthz`). What has not been watched is a session that
  actually fails to find a direct path and goes through it.
