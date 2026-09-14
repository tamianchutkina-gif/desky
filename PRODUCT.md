# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated. Chosen and recorded here so later work does not reopen it:

- **Signaling server** — Node 20+ with `ws`, no framework. The server is the one component a support engineer must trust with reachability to their clients' machines; a dependency list short enough to read end-to-end is part of the product, not an optimization.
- **Client agent** — Electron. It is the only cross-platform runtime that ships a full WebRTC stack, hardware video encoding, and a native desktop-capture API in one binary, which is what makes the "fast, no time limit" requirement achievable without writing three platform backends.
- **Input injection** — `@nut-tree-fork/libnut`, an N-API native module. N-API is ABI-stable, so the same prebuilt binary works across Node and Electron versions without a rebuild step.
- **Operator console** — plain ES modules, no build step and no framework. It is served as static files by the signaling server.

## Users

**Primary: the operator.** An independent IT consultant or technical freelancer who supports a roster of clients remotely. Sits at their own machine, usually with several client sessions across a week. They are technical, they know what latency and NAT are, and they are the one who deploys and owns the server. Their competing options are AnyDesk and TeamViewer, both of which meter them.

**Secondary: the client.** A non-technical person on their own computer who has asked for help. They are not a user of the product in any ongoing sense — they encounter it once, under mild stress, usually while something is already broken. They did not choose this tool and have no account. Their entire experience is: install an agent, read out a number, decide whether to say yes, and watch. Confirmed to be on macOS.

## Product Purpose

Let the operator work on a client's computer as if sitting in front of it, while the client watches and stays in control of the session.

Success is that the operator stops thinking about the connection. No session countdown, no "commercial use suspected" interruption, no reconnect ritual, and input latency low enough that they forget it is remote. Secondary success: the client understands what is happening without anyone explaining it to them.

## Positioning

Self-hosted, so there is no vendor to impose a session limit or a commercial-use accusation — the two failure modes that push people off AnyDesk and TeamViewer. Screen and input travel peer-to-peer under DTLS-SRTP; the server introduces the two peers and then carries nothing.

The session password is verified by the agent on the client's own machine, never by the server. This is the mechanism a hosted competitor structurally cannot copy: compromising the rendezvous server yields the ability to disrupt connections, not to authorize or observe them.

## Operating Context

The operator runs a signaling server plus a TURN relay on their own VPS behind a domain, deployed with Docker Compose. The operator console is a web page served from that same domain, so there is nothing to install on the operator's side.

The client installs a desktop agent. On macOS this requires granting two system permissions — Screen Recording and Accessibility — both of which need the app to be restarted afterward, and neither of which can be granted programmatically. This is the highest-risk moment in the entire product: a non-technical person, mid-problem, navigating System Settings.

A typical session: client opens the agent and reads out a 9-digit ID and a 6-character password over the phone; operator enters both; the client's machine shows who is asking and waits for an explicit yes; the session runs for as long as the work takes; either side ends it.

## Capabilities and Constraints

Confirmed capabilities:

- Full desktop view and control: mouse, keyboard, scroll, multi-monitor switching, clipboard in both directions.
- Sessions have no time limit. This is a load-bearing product promise.
- Quality presets from 40 Mbit/s at 60 fps down to a low-bandwidth mode.
- A local, append-only session log written on the client's machine.

Constraints that shape design:

- A browser cannot intercept every key. Cmd+Tab, Ctrl+Alt+Del and similar OS-level combinations must be offered as explicit on-screen controls; the Keyboard Lock API narrows this gap in fullscreen but does not close it.
- Peer-to-peer fails behind symmetric NAT, and traffic then falls back to the TURN relay, which costs bandwidth and adds latency. The interface must make the difference visible rather than silently degrading.
- macOS permissions cannot be granted from inside the app, only deep-linked to.
- Wayland limits screen capture on Linux. X11 is fully supported.

Deliberately out of scope for now: unattended access, file transfer, session recording, multiple simultaneous operators on one machine.

## Brand Commitments

Name: **Desky**. All interface copy is in English.

## Evidence on Hand

None. There are no customers, testimonials, benchmarks, case studies, or published performance numbers, and none may be fabricated. Latency and throughput figures may only be stated as configured targets or as live measurements the running session actually reports.

## Product Principles

1. **Visible or it does not ship.** The client can always see that a session is live, who is in it, and how to end it. Any feature that would weaken that signal is rejected regardless of its convenience to the operator.
2. **Consent is an event, not a setting.** Nothing is captured or transmitted before a person on that machine says yes to a specific, named request.
3. **The client's machine is the authority.** It holds the password, verifies the proof, and decides. The server is a phone book.
4. **No limits the product itself invents.** Session length, reconnects, and usage are bounded only by the operator's own hardware and network.
5. **The connection should be boring.** Every interface decision favors the operator forgetting the tool exists over showing them how clever it is.

## Accessibility & Inclusion

The client-facing consent and status surfaces must be legible to someone who is stressed, possibly older, and reading at a glance on an unfamiliar screen: large type, high contrast, and no reliance on color alone to signal that a session is live.
