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
