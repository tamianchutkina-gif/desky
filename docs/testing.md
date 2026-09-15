# Tests

```bash
npm test
```

109 tests: the input codec, the key table, the password proof and the key
stretching under it, the connection signature, the agent's own lockout and
replay defences, the device registry
including what it does with a corrupted file, and the full handshake with its
refusals against a real server — malformed request lines and Host headers
among them, because one of those used to end the process.

The suite runs against a real signaling server spawned for the occasion, so
`npm test` needs nothing installed beyond `npm ci --ignore-scripts` — the
packaged agent is not exercised. Every test file carries the reason each
case exists; most of them are a defect that was found once.

`npm run lint` parses everything ESLint can reach, including the console and
the renderers that no test imports.
