# ADR-0004 — Webhook delivery is durable, and queued per virtual device

**Status:** Accepted · 2026-08-22

## Context

gowa forwards webhooks fire-and-forget. From
[`webhook_forward.go`](../../reference/gowa/src/infrastructure/whatsapp/webhook_forward.go):
partial failures are logged and suppressed, an error is returned only when every
target fails, and there is no retry, no backoff, and no dead-letter queue. A
consumer that is down for thirty seconds loses those events permanently.

That is defensible for a self-hosted single-tenant tool where the operator owns
both ends. It is not defensible for a proxy that other businesses' billing flows
depend on.

There is a second problem specific to multi-tenancy: with one shared delivery
path, one unresponsive customer endpoint adds latency for every other customer.

## Decision

Every accepted event is persisted before acknowledgement, then queued **per
virtual device** in a SQLite table and delivered by a worker with:

- At-least-once semantics; consumers deduplicate on `event.id`
- Exponential backoff: 1s, 2s, 5s, 15s, 60s, 5m, 30m, 2h — 8 attempts
- A dead-letter queue, retained 7 days, replayable from the dashboard
- A per-virtual-device circuit breaker: opens after 20 consecutive failures, half-open
  probe every 60 s
- A full attempt log, queryable via `GET /v1/deliveries`

Signatures are timestamp-prefixed —
`X-Bunwa-Signature: t=<unix>,v1=<hmac-sha256 of "t.body">` — with a 5-minute
replay window. Signing the body alone, as gowa does, permits indefinite replay
of any captured payload.

## Consequences

**Good**

- Zero event loss once accepted (requirement N5)
- One customer's outage cannot delay another's events
- "Did you send it?" is answered by a query, not by log archaeology
- Replay makes customer recovery self-service

**Bad**

- The queue shares the database's write lock, so a long delivery transaction can block unrelated writes. Acceptable while one process owns both; the trigger for splitting them is the same as the Postgres trigger in [ADR-0005](0005-postgres-over-sqlite.md)
- Storage grows with event volume; retention policy required from day one
- At-least-once pushes an idempotency requirement onto consumers, which must be
  documented prominently
- Strict ordering is not guaranteed under retry — a deliberate choice of
  durability over ordering, documented in [05](../05-events-and-rules.md)
