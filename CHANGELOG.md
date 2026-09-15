# Changelog

## 0.9.0 — unreleased

First public version. Working and used daily on macOS; pre-release because
two things a remote support tool must do have not yet been watched live on
a second machine: a keystroke landing inside an application, and a session
that goes through the TURN relay rather than a direct path.

Since the private history:

- Every IPC message in the agent is checked for which window sent it, so
  a compromised engine renderer cannot read the password or accept a
  request.
- A stranger's wrong guesses lock their address out but no longer change
  the client's password.
- Proofs are shape-checked on the server before they are relayed.
- The relay refuses TCP relaying, caps bandwidth per allocation, and is
  told the server's own IPv6 addresses as well as its IPv4 one.
- `install.sh` fails when the checksum cannot be fetched instead of
  skipping the check; `publish-mac.sh` hashes the archive as served.
- The kill switch is only shown to the client when it actually registered.
- A session whose answer never arrives ends after a minute instead of
  recording indefinitely.
- Windows build removed; nothing had ever run there.

## Roadmap

No dates. Items are listed in the order they are likely to happen.

- **Verify what is not yet verified live**: a keystroke landing inside an
  application on a second machine, and a session that actually goes through
  the TURN relay. Both paths exist and are tested at the protocol level.
- **Client interface in the client's language.** The panel, the frame and
  the install page are English today; the clients they are read to are not
  all English speakers. Russian first, then a way to add others.
- **A Stop button on the frame itself**, so ending a session never depends
  on a four-key chord or on a panel the operator could have moved.
- **Signed macOS builds**: a Developer ID and notarization would remove the
  `curl | bash` install and stop permissions resetting on every update.
- **Linux**: the agent builds as an AppImage and the input module supports
  X11. It has not been run on Linux yet; Wayland capture is not supported.
- **A PAKE for the session password**, so the signaling server never sees
  anything derived from the password. Today PBKDF2 makes the offline guess
  cost more than the password's lifetime; a PAKE removes the guess entirely.
- **Not planned**: unattended access. File transfer, session recording and
  multiple operators on one machine are open, but behind everything above.
