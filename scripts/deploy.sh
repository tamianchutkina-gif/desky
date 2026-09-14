#!/usr/bin/env bash
#
# Puts the server side on a VPS and leaves it running.
#
#   scripts/deploy.sh root@203.0.113.10 desky.example.com you@example.com
#
# Everything here is idempotent: run it again after changing the code and
# it rebuilds and restarts in place, keeping the device registry and the
# TURN secret it generated the first time. Changing the secret would
# invalidate every credential already handed out, so it is generated once
# on the server and never overwritten.
#
# What it needs on the far side: Debian or Ubuntu, and a domain whose A
# record already points at that machine. The DNS check below is not a
# formality — Let's Encrypt issues nothing until the name resolves, and
# the failure it produces is opaque.

set -euo pipefail

TARGET="${1:-}"
DOMAIN="${2:-}"
ACME_EMAIL="${3:-}"   # optional: only used for certificate expiry notices
REMOTE_DIR="${REMOTE_DIR:-/opt/desky}"
SERVICE_USER="${SERVICE_USER:-desky}"

if [ -z "$TARGET" ] || [ -z "$DOMAIN" ]; then
  cat >&2 <<USAGE
usage: scripts/deploy.sh <ssh-target> <domain> <acme-email>

  ssh-target   what you would type after "ssh", e.g. root@203.0.113.10
  domain       the name pointing at that server, e.g. desky.example.com
  acme-email   optional; where Let's Encrypt sends expiry notices
USAGE
  exit 2
fi

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------
say "1/8  Reaching $TARGET"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'echo ok >/dev/null' || {
  echo "Cannot log in to $TARGET without a password prompt." >&2
  echo "Set up a key first, or run the commands by hand." >&2
  exit 1
}

REMOTE_OS=$(ssh "$TARGET" '. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID" || echo unknown')
echo "     $REMOTE_OS"

# Logging in as an ordinary user is the normal case, and everything below
# that touches the system — the package manager, the firewall, the Docker
# socket — needs root. Work that out once, here, rather than failing
# halfway through with a permission error and a half-built stack.
SUDO=$(ssh "$TARGET" '[ "$(id -u)" = 0 ] && echo "" || echo sudo')
if [ -n "$SUDO" ]; then
  ssh "$TARGET" 'sudo -n true 2>/dev/null' || {
    echo "$TARGET is not root and cannot use sudo without being asked for a password." >&2
    echo "Deploy as root, or give that account passwordless sudo." >&2
    exit 1
  }
  echo "     not root; using sudo"
fi

# ---------------------------------------------------------------------
say "2/8  Checking the domain"

# The address the server sees for itself is the one coturn must advertise;
# a domain resolving somewhere else means the certificate will never issue.
PUBLIC_IP=$(ssh "$TARGET" 'curl -s --max-time 10 https://api.ipify.org || true')
[ -n "$PUBLIC_IP" ] || { echo "The server could not determine its own public address." >&2; exit 1; }

RESOLVED=$(dig +short "$DOMAIN" A | tail -1)
echo "     $DOMAIN -> ${RESOLVED:-(nothing)}"
echo "     server   -> $PUBLIC_IP"

if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  cat >&2 <<DNS

The domain does not point at this server yet, so Let's Encrypt will
refuse to issue a certificate and Caddy will keep retrying.

Add this A record, wait for it to propagate, then run this again:

    $DOMAIN    A    $PUBLIC_IP

DNS
  exit 1
fi

# ---------------------------------------------------------------------
say "3/8  Making sure Docker and rsync are there"

ssh "$TARGET" 'command -v docker >/dev/null' || {
  echo "     installing from get.docker.com"
  ssh "$TARGET" "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && $SUDO sh /tmp/get-docker.sh"
}
ssh "$TARGET" "$SUDO docker compose version >/dev/null" || {
  echo "The Docker Compose plugin is missing and could not be found." >&2
  exit 1
}
echo "     $(ssh "$TARGET" "$SUDO docker --version")"

# The copy below runs rsync with privilege on the far side, so it has to
# exist there. A Debian netinstall does not include it, and the failure it
# produces — sudo reporting a missing command, then rsync reporting an
# unexpected end of file — names neither the package nor the machine.
ssh "$TARGET" "command -v rsync >/dev/null" || {
  echo "     installing rsync"
  ssh "$TARGET" "DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq rsync >/dev/null 2>&1"
  ssh "$TARGET" "command -v rsync >/dev/null" || {
    echo "rsync is missing on $TARGET and could not be installed." >&2
    exit 1
  }
}

# ---------------------------------------------------------------------
say "4/8  An account that owns the stack and nothing else"

# Nothing in this project has any business being root, and nothing in it
# needs to reach the rest of the machine. So the whole server side — the
# files on disk and the process inside every container — belongs to one
# account created here: no password, no shell, no sudo, nothing else on
# the machine to its name.
#
# The uid is read back and passed to compose rather than left to Docker,
# because an image's internal uid lands on whichever host account happens
# to share that number, and that account is not this one.
ssh "$TARGET" "
  set -e
  if id -u $SERVICE_USER >/dev/null 2>&1; then
    echo '     $SERVICE_USER already exists'
  else
    $SUDO useradd --system --create-home --home-dir /var/lib/$SERVICE_USER \
                  --shell /usr/sbin/nologin $SERVICE_USER
    echo '     created $SERVICE_USER'
  fi
  $SUDO passwd -l $SERVICE_USER >/dev/null 2>&1 || true
"

SERVICE_UID=$(ssh "$TARGET" "id -u $SERVICE_USER")
SERVICE_GID=$(ssh "$TARGET" "id -g $SERVICE_USER")
echo "     uid $SERVICE_UID, gid $SERVICE_GID, no shell, no sudo"

# ---------------------------------------------------------------------
say "5/8  Copying the server side to $REMOTE_DIR"

# Only what the image actually builds from. The agent is a desktop app and
# has no business on the server.
#
# /opt belongs to root and the tree ends up belonging to the service
# account, so the deploying account can write here under neither. rsync is
# given privilege on the far side instead, and lays the files down owned
# by the service account directly.
# The ownership is set afterwards rather than by rsync: --chown needs
# rsync 3, and macOS ships openrsync, which has no such option. The
# transfer runs with privilege on the far side, so the files land as root
# and are handed over here.
ssh "$TARGET" "$SUDO mkdir -p $REMOTE_DIR"
#
# -R keeps the paths whole. Without it rsync sends only the last component
# of each source, so packages/server arrives as server/ and the image
# fails to build on a COPY that is looking for packages/server — an error
# that reads as a broken Dockerfile and is a broken copy.
rsync -azR --delete \
  --rsync-path="${SUDO:+sudo }rsync" \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'turnserver.local.conf' \
  ./Dockerfile ./.dockerignore ./package.json ./package-lock.json ./shared ./packages/server ./infra \
  "$TARGET:$REMOTE_DIR/"
ssh "$TARGET" "$SUDO chown -R $SERVICE_USER:$SERVICE_USER $REMOTE_DIR && $SUDO chmod 750 $REMOTE_DIR"

# The packaged agent clients download. It sits beside the code rather
# than inside it because the rsync above runs with --delete: anything
# under a synced directory is removed on the next deploy, and a client
# whose install command has started 404ing is a support call, not a
# visible failure. Created here so the bind mount in docker-compose.yml
# finds a directory owned by the service account instead of one Docker
# invents as root. scripts/publish-mac.sh fills it.
ssh "$TARGET" "
  $SUDO mkdir -p $REMOTE_DIR/downloads
  $SUDO chown $SERVICE_USER:$SERVICE_USER $REMOTE_DIR/downloads
  $SUDO chmod 755 $REMOTE_DIR/downloads
"
echo "     done"

# ---------------------------------------------------------------------
say "6/8  Settings"

# Generated on the server, once. Every TURN credential ever issued is an
# HMAC over this value, so replacing it on a redeploy would cut off the
# sessions running at that moment.
# Absolute paths, and every read and write with privilege: $REMOTE_DIR is
# mode 750 and belongs to the service account, so the account running this
# cannot so much as cd into it. That is the point — the TURN secret sitting
# in .env is readable by root and by the service account and by nobody
# else on the machine.
ssh "$TARGET" "
  set -e
  ENVFILE=$REMOTE_DIR/infra/.env
  if $SUDO test -f \$ENVFILE && $SUDO grep -q '^TURN_SECRET=.\+' \$ENVFILE; then
    SECRET=\$($SUDO grep '^TURN_SECRET=' \$ENVFILE | cut -d= -f2-)
    echo '     keeping the existing TURN secret'
  else
    SECRET=\$(openssl rand -hex 32)
    echo '     generated a TURN secret'
  fi

  # Kept rather than reset, like the secret. This file is rewritten whole
  # on every deploy, so pinning the value here silently switched the TLS
  # relay back off on the next routine redeploy — taking every client
  # behind a TLS-only firewall with it, and saying nothing.
  if $SUDO test -f \$ENVFILE && $SUDO grep -q '^TURN_TLS=1' \$ENVFILE; then
    TLS=1
    echo '     keeping TURN_TLS=1'
  else
    TLS=0
  fi

  $SUDO tee \$ENVFILE >/dev/null <<ENV
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
PUBLIC_IP=$PUBLIC_IP
TURN_SECRET=\$SECRET
TURN_TLS=\$TLS
SERVICE_UID=$SERVICE_UID
SERVICE_GID=$SERVICE_GID
ENV
  $SUDO chown $SERVICE_USER:$SERVICE_USER \$ENVFILE
  $SUDO chmod 600 \$ENVFILE
"

# coturn reads the secret from a file rather than from its command line,
# because arguments are legible to every account on the machine through
# `ps` and /proc — which would undo the mode-600 .env above on a host
# that is shared with other services.
#
# The file is assembled here, on the server, from the config in the repo
# plus the one secret line. It is never in the repo, and rsync leaves it
# alone (it is excluded above).
ssh "$TARGET" "
  set -e
  ENVFILE=$REMOTE_DIR/infra/.env
  CONF=$REMOTE_DIR/infra/coturn/turnserver.conf
  LOCAL=$REMOTE_DIR/infra/coturn/turnserver.local.conf
  SECRET=\$($SUDO grep '^TURN_SECRET=' \$ENVFILE | cut -d= -f2-)

  $SUDO sh -c \"cat \$CONF > \$LOCAL\"
  $SUDO sh -c \"printf '\n# Written by scripts/deploy.sh from infra/.env — not in the repo.\nstatic-auth-secret=%s\n' '\$SECRET' >> \$LOCAL\"

  # The private ranges are denied in turnserver.conf, but the machine's
  # own public address is not one of them — and a VPS usually runs other
  # services too. Without this, anyone holding relay
  # credentials could use the relay to reach them.
  $SUDO sh -c \"printf 'denied-peer-ip=%s\n' '$PUBLIC_IP' >> \$LOCAL\"

  $SUDO chown $SERVICE_USER:$SERVICE_USER \$LOCAL
  $SUDO chmod 600 \$LOCAL
  echo '     turn secret written to a file the other accounts cannot read'
"

# Let's Encrypt asks for no contact address and none was given, but Caddy's
# `email` directive still requires an argument — an empty one fails to
# adapt and the whole site never comes up. So the line goes, rather than
# being handed nothing. rsync puts it back on every deploy, which is why
# this runs on every deploy too.
if [ -z "$ACME_EMAIL" ]; then
  ssh "$TARGET" "$SUDO sed -i '/email {\$ACME_EMAIL}/d' $REMOTE_DIR/infra/caddy/Caddyfile"
  echo "     no ACME address given; Caddy will register without one"
fi

# ---------------------------------------------------------------------
say "7/8  Firewall"

# Relayed media needs the UDP range open; without it the relay accepts a
# connection and then carries nothing, which is harder to diagnose than a
# refusal would have been.
#
# PATH is set explicitly because ufw lives in /usr/sbin, which a non-login
# shell does not have on it for an ordinary user. Without this the check
# below finds nothing, decides there is no firewall, and leaves every port
# shut on a machine whose default policy is deny — where the visible
# symptom is not a closed port but a certificate that never issues.
ssh "$TARGET" "
  export PATH=\"\$PATH:/usr/sbin:/sbin\"
  if command -v ufw >/dev/null && $SUDO ufw status | grep -q 'Status: active'; then
    for rule in 80/tcp 443/tcp 3478/tcp 3478/udp 5349/tcp 24000:24200/udp; do
      $SUDO ufw allow \"\$rule\" >/dev/null
    done
    echo '     ufw: opened 80, 443, 3478, 5349, 24000-24200'
  else
    echo '     ufw is not active; make sure the provider firewall allows'
    echo '     80/tcp 443/tcp 3478/tcp+udp 5349/tcp 24000-24200/udp'
  fi
"

# ---------------------------------------------------------------------
say "8/8  Starting"

# Docker creates a named volume owned by root, and every container here
# runs as the service account. A volume it cannot write is the failure
# this deployment can least afford: for the device registry it means a new
# nine-digit id for every client on every restart, and for Caddy's it
# means a certificate that cannot be saved and is requested again on each
# start until Let's Encrypt refuses to issue more.
#
# Idempotent and cheap, so it runs every time rather than only the first.
ssh "$TARGET" "
  set -e
  for vol in desky-devices desky-caddy-data desky-caddy-config; do
    $SUDO docker volume inspect \$vol >/dev/null 2>&1 || $SUDO docker volume create \$vol >/dev/null
    $SUDO docker run --rm -v \$vol:/v alpine:3 chown -R $SERVICE_UID:$SERVICE_GID /v
  done
  echo '     volumes belong to $SERVICE_USER'
"

ssh "$TARGET" "$SUDO sh -c 'cd $REMOTE_DIR/infra && docker compose up -d --build'"

# compose does not restart a container because a bind-mounted file changed
# — the container's own definition is unchanged, so it is left running with
# the old Caddyfile. Reload rather than restart: a restart would drop every
# signaling socket, and those are live support sessions.
# A reload can fail two ways and they mean opposite things. If Caddy is
# not running yet, compose has just started it with the new config and
# there is nothing to reload. If it is running and refuses, the config is
# broken — and the old one stays live, so the health check below passes
# and the deploy would otherwise report success for a change that is not
# in effect.
if ssh "$TARGET" "$SUDO sh -c 'cd $REMOTE_DIR/infra && docker compose ps --status running --services'" 2>/dev/null | grep -qx caddy; then
  if RELOAD=$(ssh "$TARGET" "$SUDO sh -c 'cd $REMOTE_DIR/infra && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile'" 2>&1); then
    echo "     caddy reloaded its configuration"
  else
    echo "" >&2
    echo "Caddy refused the new configuration and is still serving the old one:" >&2
    echo "$RELOAD" >&2
    exit 1
  fi
else
  echo "     caddy was started fresh; no reload needed"
fi

echo "     waiting for the certificate (this is the slow part)"
for attempt in $(seq 1 60); do
  if curl -sf --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    printf '\n\033[1mReady.\033[0m\n\n'
    curl -s "https://$DOMAIN/healthz"; echo
    cat <<NEXT

  Console:  https://$DOMAIN
  Agents:   wss://$DOMAIN/signal

Build the agent against it, so the client has nothing to type:

  DESKY_SERVER=wss://$DOMAIN/signal npm run host:pack

NEXT
    exit 0
  fi
  sleep 5
done

cat >&2 <<FAIL

The stack is up but https://$DOMAIN/healthz did not answer within five
minutes. Almost always the certificate: read the log, which says plainly
what Let's Encrypt refused.

  ssh $TARGET "sudo sh -c 'cd $REMOTE_DIR/infra && docker compose logs caddy | tail -40'"

FAIL
exit 1
