# Architecture decision records

One file per decision that would be expensive to reverse. Format: context,
decision, consequences — including the bad ones.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-control-plane-first.md) | Build the control plane before rewriting the engine | Accepted |
| [0002](0002-engine-adapter.md) | Abstract WhatsApp access behind a `DeviceEngine` interface | Accepted · amended 2026-08-27: one engine, not two |
| [0003](0003-process-isolation.md) | Engines run in separate processes, pooled | **Premise changed 2026-08-27** — engines are in-process; no replacement answer yet |
| [0004](0004-durable-delivery.md) | Webhook delivery is durable, per link | Accepted |
| [0005](0005-postgres-over-sqlite.md) | SQLite now, Postgres when a second process needs the data | Amended 2026-08-23 |
| [0006](0006-unix-socket-transport.md) | Unix socket transport; colocated single-container option | Superseded for v1 by 0007 · moot since 2026-08-27 |
| [0007](0007-gowa-engine-for-v1.md) | gowa unmodified on loopback is the v1 engine; Baileys is engine #2 | **Superseded 2026-08-27** — stage 4 shipped and gowa was removed |
| [0008](0008-sse-stream-tickets.md) | The SSE stream authenticates with short-lived single-use tickets | Accepted |
| [0009](0009-baileys-version-and-isolation.md) | Baileys is pinned to `7.0.0-rc14` exactly, and only one file may import it | Accepted |
