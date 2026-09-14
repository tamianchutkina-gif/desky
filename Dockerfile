# Signaling server only. The agent is a desktop app and is not built here.
FROM node:22-alpine

WORKDIR /app

# The server's only runtime dependency is `ws`, so the install layer
# stays small and rebuilds rarely.
#
# The lockfile is copied and `npm ci` is used rather than `npm install`,
# so two builds of the same commit produce the same image. Resolving
# `^8.21.3` against the live registry on every rebuild meant a new minor
# could land on a server that brokers access to clients' machines, with
# nothing recording that anything had changed.
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
RUN npm ci --omit=dev --workspace=@desky/server --install-strategy=nested

COPY shared ./shared
COPY packages/server ./packages/server

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# The ownership change must happen BEFORE the VOLUME declaration.
# Docker discards filesystem changes made to a path after that path has
# been declared a volume, so a chown below this line silently does
# nothing: /data stays root-owned, the server runs as desky, and every
# write of the device registry fails with EACCES. The symptom is the one
# thing this file most needs to prevent — every client getting a new
# nine-digit id on each restart.
RUN addgroup -S desky \
 && adduser -S desky -G desky \
 && mkdir -p /data \
 && chown desky:desky /data

# Device registrations live here. Losing this volume means every client
# gets a new nine-digit id, so it is a real volume, not a scratch dir.
VOLUME ["/data"]

EXPOSE 8080

USER desky

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/src/index.js"]
