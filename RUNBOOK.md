# Runbook

Day-to-day operation. `README.md` explains what Desky is, how to build it
and how to deploy it; this file is what you actually do with it once both
are true.

Everything here assumes the live deployment: console at
<https://desky.example.com>, agents at `wss://desky.example.com/signal`.

## Running a session

**1. The client installs the agent, once.** Send them one line:

```bash
curl -fsSL https://desky.example.com/install.sh | bash
```

Or send them <https://desky.example.com/install>, which is the same command
on a page with the reasons. They must not download the app from a browser or
a messenger: anything that arrives that way carries macOS's quarantine
attribute, Gatekeeper assesses it, an ad-hoc signature fails the assessment,
and they meet a dialog with one OK and no way past. `curl` sets no quarantine
attribute, so the same build opens with no dialog at all.

On first launch macOS asks for **Screen Recording**. Without it there is no
session. It also asks for **Accessibility**; without that the session still
runs, downgraded to view-only, and both of you are told so.

**2. The client reads you two things** from the agent window: a nine-digit
number, which is permanent for their machine, and an eight-character password
read in two runs of four,
which is not.

**3. You open the console**, enter both, and put your name in. The client sees
who is asking.

**4. The client presses Allow.** Nothing starts before that. Not the screen
capture, not the input injection — the two live in exactly one place in the
code and it is behind that button.

**5. The password is now spent.** It rotates on every ending, including a
decline and a timeout. The next session needs a new one, read aloud again.
This is deliberate: a password that survived a session would turn into a
standing key to someone's computer.

## While you are connected

- A red frame is drawn around the client's screen for as long as you have
  control. Red means that and nothing else anywhere in this product.
- Your pointer is drawn by the console itself, as a ring. The client's own
  arrow follows it a little behind — that gap is the round trip to their
  machine and back, and it is not a fault.
- The client can end the session at any moment, and so can closing their lid,
  their network, or their stopping the screen share through the system UI.

## When something is wrong

**"View only" in the console.** Accessibility is not granted. System Settings
→ Privacy & Security → Accessibility. If Desky is already listed and switched
on, the entry belongs to an older signature: remove the row with `−` and add
it again.

**The client's screen never appears.** Screen Recording, same place, same
trick with the stale entry. The agent's own log says which of the two happened
— a dropped capture is reported to you rather than silently reacquired,
because silently reacquiring would mean recording someone who chose to stop.

**The app will not launch at all** — a dialog saying it cannot be opened, one
OK. They downloaded it instead of using the install command. Delete it and run
the `curl` line.

**Nothing connects, and the console shows "relay".** The direct path failed
and the TURN server is carrying the session. It works, it is slower, and it is
the one case where traffic passes through your server — still encrypted, still
not readable there.

**A new nine-digit number every restart.** The device registry volume is not
writable by the service account. See the volumes step under “Deploying to your own server” in `README.md`.

## Changing something and shipping it

Two independent halves. Changing the console, the protocol or the server:

```bash
npm test
npm run deploy root@203.0.113.10 desky.example.com
```

Idempotent — rerun it after any change. It keeps the device registry and the
TURN secret from the first run.

Changing anything the client runs — the agent, the panel, **the icon**:

```bash
git clone --depth 1 https://github.com/tamianchutkina-gif/desky.git ~/desky-build
cd ~/desky-build && npm ci
DESKY_SERVER=wss://desky.example.com/signal npm run dist:mac:universal
./scripts/publish-mac.sh root@203.0.113.10 desky.example.com
```

**Build from a local clone, not from a folder a cloud file provider syncs.**
Packaging inside Google Drive or iCloud Drive hangs rather than finishing —
`CLAUDE.md` has the reason. From a local clone the same build takes about
two minutes.

The agent is published separately from the code and does not travel with
`npm run deploy`. Until `publish-mac.sh` runs, clients keep installing the
previous build.

**Every client then has to reinstall, and re-grant both permissions.** The
ad-hoc signature changes on every build and macOS ties permissions to it. So
batch client-side changes rather than shipping them one at a time — this is
the single strongest argument for buying a Developer ID.

## The icon

Generated from code, no source file to keep in step:

```bash
npm run icon --workspace=@desky/host
```

It writes `packages/host/build/icon.png` and `icon.icns`. To change the mark
rather than rebuild it, open `design/icon-lab.html` in a browser: the cursor
drags with the mouse, everything else is on sliders, and it exports the SVG
whose paths go back into `scripts/make-icon.mjs`. The two favicons in
`packages/server/public/index.html` and `install.html` carry the same paths
inline and are **not** generated — change the mark and they change by hand.
`DESIGN.md` holds the rules the mark obeys.

`npm run host` will not show it: that runs through the installed Electron
binary and shows Electron's icon. Only a packaged build carries it.

## What is still owed

- **A Developer ID.** It removes the install friction and stops permissions
  resetting on every rebuild. Everything else here is a workaround for not
  having one.
- **A PAKE.** The session password is eight characters stretched with
  PBKDF2, which makes an offline search by a malicious server cost days
  rather than milliseconds — long after the password it would recover has
  rotated. A PAKE is the only construction where the server never sees a
  value derived from the password at all. `CLAUDE.md` has the arithmetic.
