# Deploying to your own server

You need a VPS with a public IP and a domain whose A record already points at
it. Keep the DNS record plain — no proxy in front of it — because the relay
needs UDP reaching the machine directly, and agents take the relay's address
from the same hostname as the console.

One command does the whole thing — installs Docker if it is missing,
copies the server side across, writes the settings, opens the firewall,
and waits until the certificate is live:

```bash
npm run deploy root@203.0.113.10 desky.example.com you@example.com
```

It is safe to run again after a change: the device registry and the TURN
secret it generated the first time are kept, because replacing the secret
would cut off the sessions running at that moment.

To do it by hand instead:

```bash
cp infra/.env.example infra/.env
```

Fill in `infra/.env`. All six are required — the stack does not start
without them:

| Variable | What it is |
|---|---|
| `DOMAIN` | Your domain, e.g. `desky.example.com` |
| `ACME_EMAIL` | Address for Let's Encrypt. **Leave the line out entirely if you have none** — Caddy's `email` directive with an empty argument is a config error, and the site never comes up |
| `PUBLIC_IP` | The server's public IP |
| `TURN_SECRET` | Shared secret: `openssl rand -hex 32` |
| `SERVICE_UID` | The unprivileged account every container runs as |
| `SERVICE_GID` | Its group |

Create that account and read its ids back:

```bash
sudo useradd --system --shell /usr/sbin/nologin desky && id -u desky && id -g desky
```

Give coturn the secret in a file rather than on its command line, where
every account on the machine could read it:

```bash
cp infra/coturn/turnserver.conf infra/coturn/turnserver.local.conf
echo "static-auth-secret=$(grep '^TURN_SECRET=' infra/.env | cut -d= -f2-)" >> infra/coturn/turnserver.local.conf
```

Hand the volumes to that account before anything starts. Docker creates
them owned by root, and a volume the containers cannot write is the
failure that costs the most: the device registry stops persisting and
every client gets a new nine-digit number on each restart, while Caddy
cannot save its certificate and asks for a new one until Let's Encrypt
refuses.

```bash
for v in desky-devices desky-caddy-data desky-caddy-config; do
  docker volume create "$v" && docker run --rm -v "$v":/v alpine:3 chown -R "$(id -u desky):$(id -g desky)" /v
done
```

Start it:

```bash
cd infra && docker compose up -d
```

Open on the firewall: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `5349/tcp`,
`24000-24200/udp`.

The console will be at `https://<DOMAIN>`, and agents connect to
`wss://<DOMAIN>/signal`.

## What the deploy script does that the manual path must also do

`scripts/deploy.sh` writes `infra/coturn/turnserver.local.conf` from the
committed `turnserver.conf` plus the TURN secret, and then appends a
`denied-peer-ip=` line for the server's own public IPv4 address and for each
of its global IPv6 addresses. The committed file denies the private ranges;
it cannot know the machine's own address. Without that line, anyone holding
relay credentials can use the relay to reach whatever else the VPS runs on
its public address. If you assemble the file by hand, add those lines.

## Checking it

`https://<DOMAIN>/healthz` returns JSON with `"ok":true` and `"turn":true`
when the signaling server is up and handing out relay credentials. The
console shows **direct** or **relay** for every session, so a relay that is
configured but unreachable shows up as sessions that never connect from
networks that need it — not as an error.
