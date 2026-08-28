# bunwa

A Bun/TypeScript multi-tenant WhatsApp proxy. Speaks WhatsApp directly through [Baileys](https://github.com/WhiskeySockets/Baileys), with the tenancy, consent and delivery guarantees a shared number needs.

> Side project. The control plane works and is tested, and a first console
> screen claims a number, shows a scannable QR and watches webhook deliveries.
> It has still never run against a real device outside stage-0 measurement.

## Status

| Stage | State | What it means |
| --- | --- | --- |
| 0 — Understand gowa | ✅ | Measured against a live instance; findings in [docs/12](docs/12-stage0-findings.md) |
| 1 — Control plane | ✅ | Tenancy, consent, messaging, rules, durable webhook delivery |
| 2 — Hardening | ✅ | Verified backups, rate limits, pressure signals, housekeeping |
| 3 — Dashboard | ✅ | Claim, QR, conversations, deliveries; two image tags |
| 4 — Pivot to Baileys | ✅ | gowa removed; Baileys is the engine |
| 5 — Features | ⏳ | Ordered by real usage, not novelty |

547 tests in one suite, and `tsc --noEmit` clean. There is one `package.json`,
one lockfile and one test runner: the console used to be a subproject with its
own copy of all four, and the two halves drifted within a day. Known gaps are recorded in
[`todo.txt`](todo.txt) rather than left implicit — including two deferred
security items and two places where the implementation does not yet match the
design.

## How it fits together

bunwa is a multi-tenant control plane that also holds the WhatsApp connection.
An **engine** sits behind a seven-method `DeviceEngine` interface; Baileys is
that engine, in-process, and exactly one file may import it
([ADR-0009](docs/adr/0009-baileys-version-and-isolation.md)).

It began as a proxy in front of gowa. Stages 0-4 removed that, so bunwa now
owns the credentials, the Signal keys and the history — nothing else is left
holding them ([docs/13](docs/13-owning-the-data.md)).

Devices are system-owned and global. A project claims a phone number, and the
hierarchy above it is **Project → Environment → Virtual Device**, with the API
key scoped to an environment. If a number is already paired to another project,
the holder is asked to confirm over WhatsApp before the claim completes.

## Requirements

- [Bun](https://bun.sh) 1.4+

## Getting started

```bash
bun install
bun run dev
```

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Run the app in watch mode |
| `bun run start` | Run the app once |
| `bun run typecheck` | Type-check without emitting |

## Licence

MIT
