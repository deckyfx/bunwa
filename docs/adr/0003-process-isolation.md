# ADR-0003 — Engines run in separate processes, pooled

**Status:** Accepted · 2026-08-22 · **Premise changed 2026-08-27 — see the note at the end**

## Context

From [`event_handler.go:306`](../../reference/gowa/src/infrastructure/whatsapp/event_handler.go)
in gowa:

```go
func handleStreamReplaced(_ context.Context) {
    os.Exit(0)
}
```

One device's WhatsApp stream being replaced terminates the process and every
other device in it. This is not an outlier: an in-process WhatsApp socket can
fail in ways — panics, memory growth, protocol desync, library bugs — that are
difficult to contain within the goroutine or task that caused them.

For a single-tenant gateway this is tolerable. For a proxy where one process
holds devices belonging to different paying customers of different products, it
is not.

## Decision

The control plane holds no WhatsApp sockets. Engines run in separate processes,
grouped into **pools** of N devices (start at 25, tune from the stage 0
measurements). Each pool is independently restartable. Device→pool assignment is
stored in `devices.engine_pool_id` and is changeable at runtime.

This applies to the native engine too. A Bun worker holding 200 Baileys sockets
has the same failure mode as a Go process holding 200 whatsmeow clients.

## Consequences

**Good**

- Blast radius is bounded at N devices
- Pools can be sized differently by tier — critical customers get smaller pools
- Rolling engine upgrades, pool by pool
- Engine memory leaks are survivable via scheduled recycling
- The gowa and native engines can run side by side during migration

**Bad**

- More moving parts to deploy, monitor and orchestrate
- Cross-process communication cost on every operation
- Pool assignment becomes state that needs rebalancing
- Local development needs a compose file rather than one `bun run`

**Sizing note:** N is a trade between blast radius and overhead. 25 keeps a bad
restart to 25 devices while keeping per-device process overhead modest. Revisit
once the real per-device memory figure from stage 0 exists.

---

## Note · 2026-08-27 · the premise no longer holds, and the answer is not yet known

This ADR reasons from a specific fact: an engine is a separate process, so a
pool is a process boundary and a pool-sized blast radius is enforced by the
operating system. Stage 4 removed that fact. Baileys sockets run **in the API
process**, so a panic, a memory leak or a protocol desync in one device's socket
is in the same runtime as every other device *and* as every request handler.

What survived the change:

- `devices.engine_pool_id` still exists, `ENGINE_POOL_CAPACITY` still defaults
  to 25, and the pairing route still refuses to pair when no pool has room. So
  the number of sockets one process holds is still bounded, and bounded
  deliberately.
- The specific failure this ADR opens with — `os.Exit(0)` on `StreamReplaced`,
  one device killing every other — does not have an equivalent. The Baileys
  port handles a replaced stream as a per-device condition, which is what
  patch 3 in [10](../10-single-container.md) was proposing to do to gowa.

What did not survive:

- The bound is now on sockets rather than on containers. Nothing restarts a
  pool independently, because a pool is not a thing that can be restarted.
- "Pools can be sized differently by tier", "rolling engine upgrades, pool by
  pool" and "engine memory leaks are survivable via scheduled recycling" all
  assumed a process to recycle. None of them is available.
- "Local development needs a compose file rather than one `bun run`" is now
  false in the good direction: it is one `bun run`.

**This note deliberately stops here rather than proposing a replacement.** The
honest position is that the blast-radius argument was answered by process
isolation, that answer is gone, and nothing has replaced it — not that a worker
thread per pool is the new answer, which is a design that has not been thought
through and would be a poor thing to find asserted in an ADR later. What forces
the question is a real device and a real failure, and neither exists yet. The
constraint to keep in the meantime is the one already in the code: a bounded
number of sockets per process, so whatever the eventual answer is, it is not
being made worse in the interim.
