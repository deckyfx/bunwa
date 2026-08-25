# bunwa

A Bun/TypeScript rewrite of [gowa](https://github.com/aldinokemal/go-whatsapp-web-multidevice) — a WhatsApp Web multi-device HTTP API — plus features the original does not have.

> Side project. The control plane works and is tested, and a first console
> screen claims a number, shows a scannable QR and watches webhook deliveries.
> It has still never run against a real device outside stage-0 measurement.

## Status

| Stage | State | What it means |
| --- | --- | --- |
| 0 — Understand gowa | ✅ | Measured against a live instance; findings in [docs/12](docs/12-stage0-findings.md) |
| 1 — Control plane | ✅ | Tenancy, consent, messaging, rules, durable webhook delivery |
| 2 — Hardening | ✅ | Verified backups, rate limits, pressure signals, housekeeping |
| 3 — Dashboard | 🚧 | Project console: claim, QR, deliveries, live over SSE. No operator console, routing, styling or image build yet |
| 4 — Pivot to Baileys | ⏳ | Replace gowa as the engine ([roadmap](docs/08-roadmap.md)) |
| 5 — Features | ⏳ | Ordered by real usage, not novelty |

458 tests across two suites — 454 control plane, 4 dashboard — and
`tsc --noEmit` clean on both. `bun install` covers both projects; the dashboard
is a workspace. Known gaps are recorded in
[`todo.txt`](todo.txt) rather than left implicit — including two deferred
security items and two places where the implementation does not yet match the
design.

## How it fits together

bunwa is a multi-tenant control plane. It does not talk to WhatsApp itself: an
**engine** does, behind a seven-method `DeviceEngine` interface. gowa is engine
#1, running on the container loopback; Baileys is planned as #2, at which point
gowa becomes the fallback rather than the dependency.

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

## Upstream reference

The original Go implementation is cloned into `reference/gowa` for reading only. It is
git-ignored, excluded from `tsconfig.json`, marked read-only in VS Code, and mounted as a
second folder in `bunwa.code-workspace`.

```bash
bun run reference:update   # re-clone / fast-forward to upstream main
```

## Scripts

| Script | Description |
| --- | --- |
| `bun run dev` | Run the app in watch mode |
| `bun run start` | Run the app once |
| `bun run typecheck` | Type-check without emitting |
| `bun run reference:update` | Refresh the gowa reference clone |

## Licence

MIT
