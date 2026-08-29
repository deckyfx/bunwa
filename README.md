# bunwa

A Bun/TypeScript multi-tenant WhatsApp proxy. Speaks WhatsApp directly through [Baileys](https://github.com/WhiskeySockets/Baileys), with the tenancy, consent and delivery guarantees a shared number needs.

> Side project. The control plane works and is tested, and a console claims a
> number, shows a scannable QR, browses conversations and watches webhook
> deliveries. A real device has now paired through it — one, by hand. Nothing
> has carried production traffic.

## Status

| Stage | State | What it means |
| --- | --- | --- |
| 0 — Understand gowa | ✅ | Measured against a live instance; findings in [docs/12](docs/12-stage0-findings.md) |
| 1 — Control plane | ✅ | Tenancy, consent, messaging, rules, durable webhook delivery |
| 2 — Hardening | ✅ | Verified backups, rate limits, pressure signals, housekeeping |
| 3 — Console | ✅ | Claim, QR, conversations, deliveries; served by the API itself |
| 4 — Pivot to Baileys | ✅ | gowa removed; Baileys is the engine, and bunwa owns the data it used to hold |
| 5 — Features | ⏳ | Ordered by real usage, not novelty |

552 tests in one suite, and `tsc --noEmit` clean. There is one `package.json`,
one lockfile and one test runner: the console used to be a subproject with its
own copy of all four, and the two halves drifted within a day. Known gaps are
recorded in [`todo.txt`](todo.txt) rather than left implicit — including two
deferred security items and two places where the implementation does not yet
match the design.

## How it fits together

bunwa is a multi-tenant control plane that also holds the WhatsApp connection.
An **engine** sits behind a seven-method `DeviceEngine` interface; Baileys is
that engine, in-process, and exactly one file may import it
([ADR-0009](docs/adr/0009-baileys-version-and-isolation.md)). It is off by
default: `BAILEYS_ENABLED` has to be set, because one hand-paired device is
not a proven engine and a deployment should choose it rather than be upgraded
into one.

It began as a proxy in front of [gowa](https://github.com/aldinokemal/go-whatsapp-web-multidevice).
Stages 0-4 removed that, so bunwa now owns the credentials, the Signal keys and
the history — nothing else is left holding them
([docs/13](docs/13-owning-the-data.md)). Credentials are encrypted at rest and
Signal key ids are hashed, because Baileys' own store puts recipient phone
numbers in filenames.

Devices are system-owned and global. A project claims a phone number, and the
hierarchy above it is **Project → Environment → Virtual Device**, with the API
key scoped to an environment. If a number is already paired to another project,
the claim returns `awaiting_confirmation` and the binding stays pending until
the phone holder consents. The consent state machine and its audit log are
built and tested; sending the WhatsApp challenge and parsing the reply are not
yet wired to it.

The console is a React SPA in [`src/console/`](src/console/), served at `/app`
by the same Elysia app that answers its API calls. One origin, so there is no
proxy to keep in step and the browser's client can be Eden Treaty against the
server's own exported `App` type rather than hand-written types that drift.
Two entry points differ only in whether the console is mounted, over the shared
startup sequence in `src/boot.ts`: `src/index.ts` includes it and is what
`bun run start` and the image both reach for, `src/index-headless.ts` does not.
The headless entry point never imports the page, so nothing pulls React into
what it serves.

## Requirements

- [Bun](https://bun.sh) 1.4+

## Getting started

```bash
bun install
bun run dev
```

The API is on `http://localhost:3000` and the console on `/app`. Migrations are
applied automatically in development; in production the server refuses to start
with a pending migration instead, so `bun run db:migrate` is a deliberate step
in a deploy.

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | API and console, watch mode |
| `bun run start` | API and console, once |
| `bun run dev:headless` | API alone, watch mode |
| `bun run start:headless` | API alone, once |
| `bun run typecheck` | Type-check without emitting |
| `bun test` | The whole suite — server and console |
| `bun run db:generate` | Generate a migration from `src/db/schema.ts`, then re-embed |
| `bun run db:migrate` | Apply pending migrations |
| `bun run db:purge` | Delete the database and start blank. Asks first; `--dry-run`, `--migrate`, `--yes` |
| `bun run db:embed` | Rebuild the migration manifest compiled into the binary |
| `bun run db:studio` | Drizzle Studio against the local database |
| `bun run backup` | Take a verified snapshot; refuses one whose schema does not match the build |
| `bun run build` | Embed migrations, typecheck, compile to `dist/bunwa` |

## Licence

MIT
