# ADR-0003 — Engines run in separate processes, pooled

**Status:** Accepted · 2026-08-22

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
