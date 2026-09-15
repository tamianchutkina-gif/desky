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
- The password rotates after every session, every decline and every
  expired request. Three wrong attempts from one address lock that address
  out for a minute; they do not change the password, because letting a
  stranger's guesses do that would let anyone who knows the nine-digit
  number change the client's password at will.
- TURN credentials are short-lived (twelve hours, so a working day's
  session never loses its relay) and minted from a secret that never
  reaches a browser. The relay refuses to forward to private ranges, will
  not relay TCP, caps bandwidth per allocation, and the deploy script adds
  the server's own addresses to the denied list — a manual deployment
  must do the same.
- The device registry on the server stores hashes of device tokens, never
  the tokens themselves — a stolen registry cannot impersonate an agent.

**Nothing happens without a person present.** A session starts only after
someone at that computer presses Allow, and there is no unattended mode —
not as a setting, not as a plan. During a session a red frame sits above
every window and a kill switch (⌘⌥⇧X) ends it from anywhere.

**The session log stays on the client's machine.** It is written locally and
sent nowhere.

## What has not been done

The protocol has not had an independent audit. The threat model above, the
tests, and the reasoning in `CLAUDE.md` are what stand behind it; review is
welcome, and a report through the channel below gets a reply.

Two known weaknesses are documented rather than hidden:

- The password proof is PBKDF2-HMAC, not a PAKE. A malicious server sees
  the proof and can try passwords against it offline; the key stretching
  makes that cost years per password rather than milliseconds, and the
  password is retired after one session. A PAKE would remove the offline
  guess altogether and is on the roadmap.
- Input injection uses a prebuilt native binding (`@nut-tree-fork/libnut`,
  Apache-2.0). Its version is pinned exactly; it is not built from source
  here.

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
