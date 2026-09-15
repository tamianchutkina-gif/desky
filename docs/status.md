# What is verified, and what is not

A record of what has been watched working, and what has only been tested.
The distinction matters in a tool whose failure mode is "the client sees a
black rectangle and gives up".

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

- **A relayed session.** The relay is deployed and running on a public
  address, and the signaling server hands out credentials for it
  (`"turn":true` in `/healthz`). What has not been watched is a session that
  actually fails to find a direct path and goes through it.

## Verified between two machines

On 2026-09-02, between two separate machines over the internet: a direct path
at 292 ms RTT, pointer input landing on the far machine, and the Docker
deployment serving the console over HTTPS. The operator reported the mouse
as instant once the console drew its own cursor — the reason the console
renders a local cursor at all.
