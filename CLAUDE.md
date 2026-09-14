# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Desky is a self-hosted remote-desktop tool: an operator opens a web console,
a client runs a desktop agent, and screen plus input travel peer-to-peer over
WebRTC. `README.md` covers what it does and how to deploy it; this file covers
what you need to know before changing it.

## Commands

```bash
npm install                                   # workspaces: server + host
npm run server                                # signaling server on :8080
npm run host                                  # agent, from source
npm run dev                                   # both, wired to localhost
npm test                                      # all tests
```

Running one test file, or one test:

```bash
node --test tests/protocol.test.mjs
node --test --test-name-pattern="binding" tests/protocol.test.mjs
```

Packaging the agent. The server address is baked in at build time from
`DESKY_SERVER`, so it must be set here and not only at runtime:

```bash
DESKY_SERVER=wss://your.domain/signal npm run host:pack        # unpacked .app
DESKY_SERVER=wss://your.domain/signal npm run dist:mac --workspace=@desky/host
npm run icon --workspace=@desky/host       # regenerate the icon from code
```

There is no linter and no build step. The console and all renderers are plain
ES modules served or loaded as-is.

## Do not package from the Google Drive folder

The working copy lives under `~/Library/CloudStorage/GoogleDrive-.../My Drive/`,
and reads through that file provider run at roughly 30 KB/s. Nothing that
walks `node_modules` finishes at that rate: `npm run dist:mac:universal` there
does not run slowly, it stops — twice for 26 and 9 minutes at essentially zero
CPU, blocked inside `isexe` trying to spawn a child. It reads as a hung build
and it is a hung filesystem.

Package from a local clone instead. Clone rather than copy — the copy is
itself the slow step:

```bash
gh repo clone tamianchutkina-gif/desky ~/desky-build -- --depth 1
cd ~/desky-build && npm install
DESKY_SERVER=wss://desky.example.com/signal npm run dist:mac:universal
```

From there the whole sequence is fast: `npm install` in 6 seconds, the
universal build in about two minutes. Check free disk first — a universal
build peaks around 2.5 GB and this machine runs close to full.

## Shared code is copied, not linked

`shared/protocol.js` and `shared/desky.css` are loaded verbatim by four
different runtimes: the signaling server (Node), the agent's Electron main
process (Node), the agent's renderers (Chromium over `file://`), and the
operator console (Chromium over `https://`). So `shared/protocol.js` must stay
pure ESM with no imports and no platform APIs.

`scripts/sync-shared.mjs` copies those files into `packages/host/` before every
agent start and every build, and writes `packages/host/src/build-config.json`
from `DESKY_SERVER`. **Editing anything under `packages/host/shared/` or
`packages/host/renderer/fonts*` is pointless — it is overwritten.** Edit the
originals in `shared/` and `packages/server/public/`.

`KEY_TABLE` in the protocol is positional: the wire carries an index into it.
Append only. Reordering it makes an old agent type the wrong characters for a
new console.

## Agent process topology

The agent is four processes, split by what each runtime can do — WebRTC and
screen capture exist only in Chromium, native input injection only in the main
process. Everything crosses through IPC and a narrow `contextBridge`.

| Process | Owns |
|---|---|
| `src/main.js` | signaling socket, consent, native input, session log, permissions, all state |
| `renderer/engine.js` (hidden window) | `RTCPeerConnection`, screen capture, both data channels |
| `renderer/panel.js` | everything the client sees and decides |
| `renderer/border.js` | the click-through frame drawn over the shared screen |

The agent is the WebRTC **offerer** — it holds the media and creates both data
channels; the console answers. Two channels, deliberately different: `input` is
unordered with no retransmission and carries binary frames (a resent mouse
position is worse than a dropped one), `control` is reliable JSON.

`main.js` is the security boundary. Renderers hold no session logic: a bug in
`panel.js` cannot grant access.

## The operator console, and where the lag actually is

The video round trip — inject, macOS redraws, capture, encode, send, decode,
render — is 60–150 ms on a good link and does not get shorter by tuning. So
nothing the operator does with their hand may wait on it.

- **The console draws its own cursor.** `cursor: none` on `.screen` was a
  latency bug wearing a stylist's clothes: it left the operator watching a
  pointer that exists only inside the video, so every movement had to complete
  the whole round trip before it appeared to move. On a 300 ms link that is
  most of half a second of the mouse visibly lagging the hand, and it reads as
  "the whole thing is slow" rather than as a rendering choice. Every serious
  remote-desktop client draws the pointer locally for this reason. It is a ring
  rather than an arrow deliberately: the client's own arrow is still in the
  picture a little behind, and the two must read as "where I am" and "where
  that machine has got to", not as one cursor drawn twice.
- **Nothing overlays the picture.** The toolbar is a real grid column beside
  the video, not an absolutely-positioned bar over it. Overlaid, it took the
  top ~80 px of the client's screen with it — their menu bar and the close
  button of whatever they had open — and it revealed itself on `clientY < 90`,
  which is the same gesture as reaching for exactly those things.
- **Edges need a snap margin.** `EDGE_SNAP_PX` in `packages/server/public/input.js`.
  The console is a browser window, so the bottom of the picture is wherever
  that window ends: push the mouse past it and `pointermove` stops firing,
  leaving the client's cursor parked a pixel short of the boundary. That pixel
  is the one that reveals an auto-hidden Dock. All three pointer handlers
  clamp; none refuse a position, because a refused move is a cursor that stops
  before the edge and a refused release is a drag dropped in the wrong place.
- **`libnut` posts real events** (`CGEventCreateMouseEvent` + `CGEventPost`,
  never `CGWarpMouseCursorPosition`), so the Dock and the menu bar do react to
  injected motion. When an edge does not respond, the position never arrived —
  look at the console, not at the injector.
- **`#move` clamps inside the display.** `bounds.y + bounds.height` is the
  first row of whatever screen sits below this one, so a normalized 1.0 aimed
  the client's cursor at the wrong monitor.

## Two traps in the capture pipeline

`track.getSettings()` reports nothing until the first frame has been
delivered, and the transceiver is created and the encoding applied in the same
tick the capture promise resolves. Anything derived from the track's size at
that point is derived from zero. That is how `scaleResolutionDownBy` came out
as 1 for the life of every session: a preset asking for 1920 encoded 2880 —
2.25× the pixels — with the frame rate collapsing to keep up. The display's own
size is the fallback and is known synchronously; `applyEncoding()` runs again
on `connected`, when the track is finally honest. The symptom is visible from
the console: `SCREEN` reporting the client's raw screen size under a preset
that asked for less.

`contentHint = 'detail'` and `degradationPreference = 'maintain-framerate'`
pull against each other by design. The hint keeps text sharp; the preference
decides what gives way under congestion, and for a screen someone is *driving*
that must be resolution, not frames.

## The consent and trust model

Two gates, in this order, and neither can be skipped:

1. **`handleIncomingRequest`** verifies the operator's HMAC proof against the
   session password, which never leaves the client's machine. The server relays
   the proof but cannot check it.
2. **`acceptRequest`** runs only after a human presses Allow. `injector.enable()`
   and `engine:start` exist nowhere else.

The proof alone is not enough, because the server decides whose SDP reaches
whom and could sit in the middle. So each side signs its own DTLS fingerprint
with the session password (`computeBinding` / `verifyBinding`) and the other
verifies it. A missing binding is treated as invalid so it cannot be stripped.

When changing anything here, keep these true: nonces are single-use
(`Identity#verify`), the password rotates on every terminal outcome including
decline and timeout, and every exit path reaches `injector.disable()` so a
dropped session never leaves a modifier held down on the client's keyboard.

## macOS permissions, and why iterating hurts

Screen Recording is a hard requirement. Accessibility is not: without it a
session still runs, downgraded to view-only, and both sides are told so
(`permissions.ok` vs `permissions.canControl`).

macOS ties both permissions to the app's code signature. An ad-hoc-signed build
gets a new signature every time it is packaged, **so every `npm run host:pack`
resets the client's permissions.** This makes packaged builds a poor way to
iterate.

Use `npm run host` instead while developing: it runs through the installed
Electron binary, whose identity is stable across code changes, so permissions
granted once survive every edit. (They do reset if `npm install` replaces the
Electron binary.)

Two related traps worth recognising:

- A permission can appear switched on in System Settings and still not be
  trusted, because the entry belongs to an older signature. The fix is to
  remove the row with `−` and re-add it.
- A `kill -9`'d agent leaves a stale `SingletonLock` in
  `~/Library/Application Support/Desky/`. Chromium refuses to reclaim it if
  the hostname has since changed, and the next launch dies. Delete the
  `Singleton*` files.

### Signing a universal build: `--deep` is not enough

A universal `.app` is merged from an x64 and an arm64 one with `lipo`,
which writes fresh Mach-O files and drops whatever signatures they
arrived with. `codesign --force --deep --sign -` then re-signs the
bundle and the nested bundles — but not a `.dylib` inside a framework's
`Libraries` folder, and not a `.node` under `app.asar.unpacked`. To
codesign those are sealed resources, not code.

The result passes `codesign --verify --deep --strict` and still cannot
launch: dyld refuses the unsigned libraries, which on Apple Silicon is
fatal, and the client meets the dead-end *"Desky" cannot be opened*
dialog with a single OK. The bundle verifying clean is exactly what
makes this expensive to find.

So `build/adhoc-sign.cjs` signs every Mach-O individually, deepest path
first, bundle last — then verifies each one separately and fails the
build if any is unsigned. Do not replace that with a single `--deep`
call, however much shorter it reads.

The same build also has to skip signing the two per-architecture slices,
because the merge refuses to run unless their non-binary files match
byte for byte, and separate signatures give each its own
`CodeResources`. electron-builder still wraps those unsigned slices into
their own `.dmg` files; `scripts/keep-universal.mjs` deletes them, since
shipping one is the failure a client cannot get past. Build it with
`npm run dist:mac:universal`, which is that whole sequence.

### Ad-hoc signing gets the app running, not installed

Signing solves dyld. It does nothing about Gatekeeper, and the two were
conflated here until a client met the dead-end dialog on a bundle whose
every binary was correctly signed.

Anything a browser, Telegram, Mail or AirDrop hands over carries
`com.apple.quarantine`, and Gatekeeper assesses every quarantined bundle.
An ad-hoc signature is valid but traceable to no developer, so the
assessment fails — `spctl -a` says `rejected`, which is expected and is
not a broken build. On macOS 15 the Ctrl-click bypass is gone, and an
ad-hoc signature earns no *Open Anyway* line in System Settings either.
The client is simply stuck.

So clients do not download the app. They run

```bash
curl -fsSL https://desky.example.com/install.sh | bash
```

`curl` sets no quarantine attribute, an unassessed bundle launches on the
ad-hoc signature alone, and no dialog appears at all. `install.sh` and
the page at `/install` live in `packages/server/public/` with the origin
left as `__DESKY_ORIGIN__`; `packages/server/src/install.js` claims those
two paths ahead of the static handler and fills the origin in from the
request, so a script always points back at the server that served it and
nothing in the repo is tied to one deployment.

The build itself is published separately from the code —
`scripts/publish-mac.sh` uploads the universal `.zip` to
`$REMOTE_DIR/downloads`, mounted read-only into the signaling container
and served at `/download`. It is `../downloads` in the compose file, not
`./downloads`: `infra/` is synced with `rsync --delete`, so an archive
inside that tree would vanish on the next routine deploy and the first
sign of it would be a client's install command returning 404.

None of this replaces a Developer ID. Notarization is still the only
thing that removes the extra step and stops permissions resetting on
every rebuild.

`watchRenderer` in `main.js` forwards renderer console errors to the agent's
stdout. Without it a broken renderer script is invisible: every section starts
hidden, so the window simply paints blank.

## Tests

`tests/protocol.test.mjs` is pure unit work on the wire format, key table,
password proof and connection binding.

`tests/identity.test.mjs` and `tests/store.test.mjs` cover the two files that
decide who gets in and which machine is which. Both were untested until an
audit found a lockout that erased itself on the next line and a registry that
overwrote itself after a bad read — neither of which any amount of care in
`main.js` or `hub.js` could have caught. `Identity` takes an optional data
directory so it can be constructed without an Electron runtime; pass one in
tests and nothing else changes.

`tests/handshake.test.mjs` spawns the **real** signaling server as a child
process and drives two WebSockets through the actual protocol. It raises
`ATTEMPTS_PER_MINUTE` and `REGISTRATIONS_PER_HOUR` in the child's environment,
because every peer in the suite shares one address and the production limits
would throttle the tests rather than the behaviour under test; the limits get
their own dedicated test.

Server behaviour is configured entirely by environment variables read in
`packages/server/src/config.js` — that is the list of what is tunable.

## Design

`PRODUCT.md` holds product truth, `DESIGN.md` the visual system, and both are
binding. Two rules there are load-bearing rather than decorative:

- Seal red means exactly one thing — control of this machine is currently
  released to someone else. Never an error colour, never a hover.
- Colour lives in the stock, not the ink: the operator console and the client
  panel are the same document on different paper, which is why there is one set
  of ink tokens and two stocks rather than two themes.

Copy is English throughout. The only non-Latin strings in the repo are
deliberate Unicode fixtures in `tests/protocol.test.mjs`.

## The icon

`scripts/make-icon.mjs` draws the mark as an HTML page, captures it through
Electron at every size macOS wants, and assembles `.icns` with `iconutil`.
Electron rather than a rasterizer because this machine has no SVG rasterizer
and Electron is already a dependency.

Four things about it are load-bearing:

- **The 100-unit margin is artwork, not padding.** The body is 824x824 in a
  1024 canvas, per Apple's grid, and everything outside it stays transparent.
  macOS insets nothing on your behalf; a full-bleed square stands taller than
  every system icon next to it.
- **`transform` scales stroke width.** The cursor's outline is specified as
  `20.3` so that it lands at 15 units after the group's own `scale(0.74)`.
  Change the scale without dividing again and the outline grows with the
  arrow until it swallows the tail.
- **The letter is one path with `fill-rule="evenodd"`.** The counter is a real
  hole. A background-coloured patch instead would put the ground colour in
  two places and stop the counter being transparent.
- **The counter is an ellipse and the outer bowl is a circle.** That
  asymmetry is the optical correction, not a mistake: the counter keeps
  `rx` 212, which holds the stem and the right of the bowl at a full 84,
  while `ry` 220 takes the two arms to 76 — 9.5% thinner, which is what
  makes them read as the same weight. Make the counter circular again and
  the letter goes back to looking top-heavy. If `lr` or the stroke ever
  changes, `ry` has to be recomputed as `lr` minus the thinned horizontal.

The same three paths are pasted into the `<link rel="icon">` data URIs in
`packages/server/public/index.html` and `install.html`. Nothing generates
those — change the mark and they have to be changed by hand.

`design/icon-lab.html` is where the mark is adjusted — a standalone page with
the same geometry on sliders and an SVG export, including the thinning as a
percentage. Its defaults reproduce the shipped path character for character;
if they ever stop doing so, one of the two has been changed alone. It is a
design tool, not part of any build, and nothing imports it — which is also
why its own labels are in Russian rather than English. That is the single
exception to the copy rule below, and it is deliberate: nothing a client or
an operator ever sees is in it.

`npm run host` shows Electron's own icon in the Dock, not this one, because
it runs through the installed binary. Only a packaged build carries it, and
packaging resets the client's macOS permissions — so check the icon once, on
a build, rather than while iterating.

## Where this stands

Operational notes about a particular deployment — the host, its accounts,
what has already run there — live outside the repository, in `.private/`,
which is ignored by git. Nothing that names a real server belongs in a
committed file.

Verified live on 2026-08-27, on macOS, over a real session: screen capture at
2880×1800, a direct peer-to-peer connection at 5 ms, and input frames reaching
the injector. Three defects were in the way, all now fixed and all invisible
from the outside:

- `[hidden]` did not work on any element carrying a class that sets `display`.
  Both renderers hide things by setting that attribute and trusting it, so the
  panel and the console showed warnings nothing could clear — including "View
  only" during a session that did have control. The rule now lives once, in
  `shared/desky.css`, and outranks what follows it.
- `setPermissionRequestHandler` refused everything, and Chromium gates
  `getDisplayMedia` through it, so the agent denied its own screen capture. It
  arrived as `NotAllowedError` — indistinguishable from macOS withholding
  Screen Recording, which sends everyone into System Settings after a
  permission that was never the problem.
- `screen.dipToScreenPoint` exists only on Windows. On macOS the first pointer
  move a session ever carried took down the main process, which is why no
  keystroke had ever landed.

Verified live on 2026-09-02, between two separate machines over the internet:
a direct path at 292 ms RTT, pointer input landing on the far machine, and the
Docker deployment serving the console. The operator reported the mouse as
instant once the console drew its own cursor — which is the whole of the
argument in "The operator console" above, and the reason it is written down
rather than left as a CSS line.

Still unverified: a keystroke arriving in an application, the TURN relay, and
the encoder scaling fix — that one lives in the agent, so it is only real on a
machine that has reinstalled since it was built.

## The audit of 2026-08-27, and what it changed

A full review found defects that no test covered because the files holding
them had no tests. The ones worth carrying forward as knowledge rather than
as changelog:

- **`new URL()` in a request listener is fatal.** `GET //` throws
  `ERR_INVALID_URL`, and a throw there ends the process and every live
  signaling socket with it — a scanner could end every session on the server
  by accident. It is wrapped now, and `tests/handshake.test.mjs` drives raw
  malformed request lines and Host headers over a socket to keep it that way.
- **The agent's lockout never engaged.** `rotatePassword()` clears
  `#lockedUntil`, and it was called *after* the deadline was set, erasing it.
  Everything built on top — the panel's countdown, `startLockCountdown`, the
  promise in the README — described a state the class could not reach. Order
  matters in `Identity#verify`; the tests now assert the lockout is real.
- **A token being present is not a token being right.** `hub.js` treated any
  non-empty token as a reclaim, so both registration gates were skipped for
  what `claim()` then handled as a fresh mint. `DeviceStore#verify` exists to
  make that check explicit, and the hub must use it rather than testing
  truthiness.
- **The agent had no ICE candidate buffer.** The console has always had one;
  the agent applied remote candidates unconditionally, and `addIceCandidate`
  throws before a remote description exists. Since the console emits its first
  candidates before its answer is signed and sent, the operator's *host*
  candidates — the direct path on a shared LAN — were the ones being dropped.
  Both sides buffer now, and they must stay symmetric.
- **Starting empty after a bad read is how a registry is lost.** The store
  moves a damaged `devices.json` aside and refuses to write until a person
  intervenes, rather than replacing it on the next registration.
- **Direct-vs-relay is a privacy claim, so it has to be true.** The path
  indicator scanned every local candidate rather than the nominated pair's, so
  any deployment with TURN configured reported "relay" for perfectly direct
  connections.

Two things the audit did **not** change, deliberately, because they are
design decisions rather than defects:

- **A dropped screen capture still ends the session.** Silently re-acquiring
  it would mean a client who stopped sharing through the system UI gets
  recorded again, which is worse than the session ending. The operator is now
  told which of the two happened instead.
- **A closed signaling socket still closes the session.** Letting an active
  session outlive it would need a reattach path, and getting that wrong leaves
  the injector armed for a peer that is gone.

The remaining known weakness is an offline search by a malicious signaling
server. It holds every input to the password proof except the password, so it
can guess offline against a proof it relayed, and a recovered password forges
the fingerprint bindings that are supposed to make a substituted SDP
detectable — which is what the README's claim that a compromised server
"cannot open, substitute, or watch" a session rests on.

It used to be free. Six characters of a 31-character alphabet is 29.7 bits,
`computeProof` was a bare HMAC over it, and a laptop finished the search
before the operator finished typing. It now costs: eight characters (39.6
bits) and a key derived with PBKDF2-SHA-256 at `PROOF_ITERATIONS`, so each
candidate is 1.2 million iterations rather than one hash. Exhausting the space
is about 2e18 SHA-256 compressions — over a decade for one GPU, days for a
thousand — against a password that lives for one session and rotates on every
ending, including a decline and a timeout. The attack is not impossible; it
arrives late, which for a credential with this lifetime is the same thing.

`PROOF_ITERATIONS` and `PASSWORD_LENGTH` are both wire-visible: both sides
must agree, so changing either belongs with a `PROTOCOL_VERSION` bump. The
version check in `hub.js` is what turns an old agent into "Update the agent"
rather than "wrong password", and `tests/handshake.test.mjs` pins that.

A PAKE is still the only thing that closes this properly, because it is the
only construction where the server never sees a value derived from the
password at all.
