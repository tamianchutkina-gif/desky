# Desky

[![tests](https://github.com/tamianchutkina-gif/desky/actions/workflows/test.yml/badge.svg)](https://github.com/tamianchutkina-gif/desky/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node ≥ 22.12](https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933)

**Remote support the client stays in charge of.** You connect to a client's
computer and work on it as if you were sitting there. Nothing is shared
until they press Allow, they see who is in and what is happening, and one
key ends it. Self-hosted, so there is no session timer and nobody to declare
your work "commercial use".

<!-- screenshot: docs/img/console-session.png — the operator's console on
     the left, the client's panel with the red frame on the right. -->

## Why this exists

AnyDesk and TeamViewer meter you: session timers, "commercial use
suspected", reconnect rituals. Those limits are commercial, not technical.
Desky runs on your own VPS, so there is nobody to impose them — and the
design goes one step further than "self-hosted": **the server is treated as
untrusted.** Even an attacker who owns it cannot open, substitute, or watch
a session.

- No session limits, no accounts, no vendor
- Consent is an event: nothing is captured until the client presses Allow
- Peer-to-peer WebRTC; the server never sees screen, input, or password
- A single-use session password, retired every time a session ends
- A red frame the client cannot hide, and a kill switch that works from any app
- H.264 with hardware encoding, up to 60 fps, about 3 ms on a local network
- One command to deploy, one line for the client to install
- No unattended access — by design, not by omission

I help small businesses put their tools in order, and much of that work
happens on the client's own computer. What bothered me about the usual
tools was not only the meter but the other side of it: my clients were
installing something that could, in principle, let anyone in at any time,
and they had no way to tell. Desky is the version I am comfortable asking
a client to install. — [Tamilya Anchutkina](https://github.com/tamianchutkina-gif)

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
input travel **directly** between your computers; the relay is used only
when no direct path exists, and the console always shows which one is in
use.

The password is checked by the agent on the client's own machine, never by
the server. Since the server decides whose connection description reaches
whom, it could hand each side its own and sit in the middle — so each side
signs its DTLS fingerprint with a key derived from the session password,
and the other side verifies that signature before anything flows. The
server has no password, so it cannot forge one. [SECURITY.md](SECURITY.md)
has the full threat model, including what it does not cover.

## Quickstart

Locally, to see it work:

```bash
npm install
npm run server
```

In another terminal:

```bash
DESKY_SERVER=ws://localhost:8080/signal npm run host
```

Open <http://localhost:8080> and enter the number and password from the
agent window.

On your own VPS — one command installs Docker if needed, copies the server
side across, opens the firewall and waits for the certificate:

```bash
npm run deploy root@203.0.113.10 desky.example.com you@example.com
```

Then bake the address into the agent and publish it, and clients install
with one line:

```bash
DESKY_SERVER=wss://desky.example.com/signal npm run dist:mac:universal
./scripts/publish-mac.sh root@203.0.113.10 desky.example.com
```

```bash
curl -fsSL https://desky.example.com/install.sh | bash
```

## Documentation

| | |
|---|---|
| [Deploying to a VPS](docs/deploy.md) | Docker Compose, TURN, certificates, the manual path and what it must not skip |
| [Shipping the agent to a Mac](docs/macos-distribution.md) | Building, ad-hoc signing, Gatekeeper, why `curl` and not a `.dmg`, the two permissions |
| [Running a session](docs/runbook.md) | What you and the client do, and what to check when it goes wrong |
| [Threat model](SECURITY.md) | What the design assumes, what it does not cover, how to report |
| [Status](docs/status.md) · [Tests](docs/testing.md) | What has been watched working, and how the suite is built |
| [Product](docs/product.md) · [Design](docs/design.md) | Why the interface looks and behaves the way it does |

## What is in here

| Folder | What it is |
|---|---|
| `shared/` | Protocol and stylesheet — the same files for every part |
| `packages/server/` | Signaling server and the operator console |
| `packages/host/` | The agent that gets installed on a client's machine |
| `infra/` | Docker Compose: server, TURN, HTTPS |
| `scripts/` | Deploy, publish, build helpers |
| `tests/` | Protocol, identity and full-handshake tests against a real server |
| `docs/` | Everything linked above |

## Compared with the usual tools

| | Desky | AnyDesk / TeamViewer (free) | RustDesk (self-hosted) | Chrome Remote Desktop |
|---|---|---|---|---|
| Session time limit | None | Cut-offs and "commercial use" flags; paid from ~$15/mo | None | Re-confirm every 30 min |
| Who runs the server | You | The vendor | You | Google |
| Can the server watch a session | No — password verified on the client, connection signed | Vendor relay by design | Trust is in the server | Google infrastructure |
| Unattended access | Never, by design | Yes | Yes, the default | Yes |
| Client sees the session is live | Red frame over every window, kill switch | Small indicator | Indicator | Toolbar |
| Platforms verified today | macOS clients; Linux/X11 builds, unverified | All | All | Win/Mac/Linux |
| File transfer, recording | Not yet | Yes | Yes | No |

## Status

**Working, pre-release.** Used daily on macOS. Verified live between two
machines over the internet: a direct path, the screen at 2880×1800, pointer
input landing on the far side, the Docker stack serving the console over
HTTPS. The automated suite covers the protocol, the password proof, the
connection signature, the device registry and the full handshake against a
real server.

Not yet watched live: a keystroke landing inside an application on the far
machine, and a session that actually goes through the relay. Both paths
exist and are tested at the protocol level; the honest word until someone
watches them is *unverified*.

Not built: file transfer, session recording, more than one operator at a
time, Wayland capture. Not planned: unattended access — it is the feature
that turns a support tool into a standing key.

Builds are ad-hoc signed; a Developer ID and notarization are on the
roadmap, and until then the install script verifies the archive's checksum
over HTTPS. The protocol has not had an independent audit; review is
welcome.

## Built with Claude Code

`CLAUDE.md` is the file an AI assistant reads before touching this
repository: process topology, the trust model, the traps in the capture
pipeline and in macOS signing. It doubles as the engineering notebook — if
you want to know *why* something is the way it is, that is where the
reasoning lives.

## Contributing

Issues are welcome, with the template. Pull requests are welcome for
anything in [Status](#status) or the roadmap in
[CHANGELOG.md](CHANGELOG.md); run `npm run lint && npm test` first. One
maintainer, replies weekly. Windows and unattended access are not planned.

## License

MIT. Desky is a name, not a trademark — fork it, rename it, ship it. Fonts
and the native input binding carry their own licences, listed in
[`packages/server/public/fonts/README.md`](packages/server/public/fonts/README.md)
and [SECURITY.md](SECURITY.md).
