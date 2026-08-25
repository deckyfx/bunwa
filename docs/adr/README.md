# Architecture decision records

One file per decision that would be expensive to reverse. Format: context,
decision, consequences — including the bad ones.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-control-plane-first.md) | Build the control plane before rewriting the engine | Accepted |
| [0002](0002-engine-adapter.md) | Abstract WhatsApp access behind a `DeviceEngine` interface | Accepted |
| [0003](0003-process-isolation.md) | Engines run in separate processes, pooled | Accepted |
| [0004](0004-durable-delivery.md) | Webhook delivery is durable, per link | Accepted |
| [0005](0005-postgres-over-sqlite.md) | SQLite now, Postgres when a second process needs the data | Amended 2026-08-23 |
| [0006](0006-unix-socket-transport.md) | Unix socket transport; colocated single-container option | Superseded for v1 by 0007 |
| [0007](0007-gowa-engine-for-v1.md) | gowa unmodified on loopback is the v1 engine; Baileys is engine #2 | Accepted · amended 2026-08-25: Baileys is a committed stage 4 |
| [0008](0008-sse-stream-tickets.md) | The SSE stream authenticates with short-lived single-use tickets | Accepted |
