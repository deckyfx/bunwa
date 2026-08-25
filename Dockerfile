# Two tags from one build (docs/07).
#
#   docker build --target api  -t bunwa:api  .
#   docker build --target full -t bunwa:full .
#
# The binary is identical. `full` copies the console in and `api` does not, and
# the control plane serves /app only when those files exist — so nothing needs a
# build flag or a runtime switch to tell the images apart.

FROM oven/bun:1.4.0-slim AS deps
WORKDIR /build
# Manifests first, so a source-only change does not reinstall.
COPY package.json bun.lock ./
COPY dashboard/package.json ./dashboard/
RUN bun install --frozen-lockfile

FROM deps AS console
WORKDIR /build
COPY dashboard ./dashboard
COPY tsconfig.json ./
RUN cd dashboard && bun run build

FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Not root. The process needs to write only its database directory, which is a
# volume, so everything it ships with can stay read-only to it.
RUN useradd --system --uid 10001 --create-home bunwa
COPY --from=deps /build/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY drizzle.config.ts ./
# Created in the image and owned by the runtime user, so a fresh named volume
# mounted here inherits that ownership. Without it Docker creates the mount
# root-owned, the non-root process cannot open its own database, and the
# container dies on a SQLite error that says nothing about permissions.
# Verified: it failed exactly that way before this line existed.
RUN mkdir -p /data && chown bunwa:bunwa /data
VOLUME ["/data"]
ENV DATABASE_PATH=/data/bunwa.sqlite     RUNTIME_DIR=/data

USER bunwa
EXPOSE 3000
# The server does not migrate. In production it inspects the schema and exits
# 75 if anything is pending, rather than altering a database as a side effect of
# a restart — a container that migrates on boot will do so on every boot,
# including the one where a rollback put an older image in front of a newer
# schema.
#
# Apply them deliberately, once per deploy, before starting:
#
#   docker run --rm -e DATABASE_PATH=... bunwa:api bun run src/db/migrate.ts
#
# Verified: without that step both images exit 75 with "pending migrations",
# which is the guard working and not a packaging fault.
CMD ["bun", "run", "src/index.ts"]

# The API alone. No dashboard assets are present, not merely unrouted.
FROM runtime AS api

# The API plus the console, served at /app by the same binary.
FROM runtime AS full
COPY --from=console --chown=bunwa:bunwa /build/dashboard/dist ./dashboard/dist
