# ADR-0005 — Postgres, not SQLite

**Status:** Accepted · 2026-08-22

## Context

gowa defaults to SQLite (`file:storages/whatsapp.db`) and this works well for
it: one process, owning its own devices, with no concurrent writers. Bun also
ships an excellent native SQLite driver, which makes it the path of least
resistance.

bunwa's shape is different. The control plane, several engine pools and a set of
delivery workers all need consistent, concurrent access to the same link,
consent and delivery state.

## Decision

Postgres, accessed through Drizzle. Engine-side session credentials remain
wherever the engine keeps them — gowa's SQLite store stays gowa's business.

## Consequences

**Good**

- Real concurrent writers without lock contention
- Row-level security as a second line of tenant isolation ([04](../04-data-model.md))
- `jsonb` with indexing for rule definitions and event payloads
- `LISTEN`/`NOTIFY` available for cross-process invalidation
- Standard operational tooling: backups, replicas, point-in-time recovery

**Bad**

- A server dependency, so no truly single-binary deployment for the control plane
- Heavier local development setup than a file
- Migrations must be expand-migrate-contract, since engine pools and the control
  plane deploy independently

**Rejected alternative — SQLite with a single writer process.** Achievable, but
it makes the writer a scaling bottleneck and a single point of failure, which
contradicts [ADR-0003](0003-process-isolation.md).
