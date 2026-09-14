# Security

Desky is remote control of someone else's computer. The threat model is the
reason the project exists, so it is written down here rather than implied.

## What the design assumes

**The signaling server is not trusted.** It introduces the two sides and
nothing more. Screen, input and the session password never pass through it.
An attacker who fully controls the server can break a connection; the design
is meant to leave them unable to open one, substitute one, or watch one.

- Each side signs its own DTLS fingerprint with a key derived from the
  session password, and the other side verifies that signature before media
  flows. A server that hands each peer a forged connection description
  cannot produce a valid signature, because it never holds the password.
- The password is checked on the client's machine, by the agent, never by
  the server.
- The key is derived with PBKDF2-SHA-256 over 1 200 000 iterations, so an
  offline guess at an eight-character password — the one attack a malicious
  server is positioned to try — costs GPU years, not milliseconds.
- Every handshake is single-use. A captured proof cannot be replayed.
- The password rotates after every session, every decline, every expired
  request and every three wrong attempts, which also locks the agent for a
  minute. Rotation is shown to the client so a surprise change reads as the
  warning it is.
- TURN credentials are minted per session from a secret that never reaches
  a browser; the relay refuses to forward to private ranges and to the
  server's own address.
- The device registry on the server stores hashes of device tokens, never
  the tokens themselves — a stolen registry cannot impersonate an agent.

**Nothing happens without a person present.** A session starts only after
someone at that computer presses Allow, and there is no unattended mode —
not as a setting, not as a plan. During a session a red frame sits above
every window and a kill switch (⌘⌥⇧X) ends it from anywhere.

**The session log stays on the client's machine.** It is written locally and
sent nowhere.

## What the design does not cover

- An attacker with code execution on either endpoint. Desky does not defend
  a machine against its own owner or against malware already on it.
- Shoulder-surfing the password as the client reads it aloud. Rotation
  limits the damage to one session; it does not prevent it.
- A relay operator seeing traffic *metadata* — who connected to whom and
  when. Content is DTLS-SRTP encrypted end to end; timing and volume are
  not hidden.
- Builds without an Apple Developer ID are ad-hoc signed. That keeps macOS
  from refusing to launch the app, but it means a modified build cannot be
  told from a genuine one by signature alone. `install.sh` verifies a
  checksum against the publishing server over HTTPS for that reason.

## Reporting a vulnerability

Please do not open a public issue for anything exploitable. Use GitHub's
private vulnerability reporting on this repository (Security → Report a
vulnerability). Reports get a reply within a few days; a fix and a credit
follow when the report holds up.
