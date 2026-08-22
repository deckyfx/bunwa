# ADR-0007 — gowa is the v1 engine; Baileys is engine #2

**Status:** Accepted · 2026-08-22 · Supersedes the provisional position in
[ADR-0002](0002-engine-adapter.md) on *when* the native engine arrives

## Context

The v1 requirements narrowed considerably: six message types (text, image, PDF,
link preview, audio, video), no groups, no chat storage, calls explicitly
ignored, and a single-container deliverable in two flavours (`api`, `api+dashboard`).

That cut most of what made a native engine expensive. The estimate for a Baileys
`DeviceEngine` fell from ~3,500 lines and 10–13 weeks to ~2,000–2,500 lines and
4–6 weeks ([11](../11-engine-decision.md)). The decision genuinely reopened.

Two facts decided it:

1. **The primary use case is OTP.** A late or missing OTP is a failed login, per
   user, at the moment of highest intent. It is the least forgiving traffic
   there is, and it makes protocol-maintenance response time a product
   requirement rather than an engineering preference.
2. **All six required send types already exist in gowa** as tested endpoints:
   `/send/message`, `/send/image`, `/send/file`, `/send/link`, `/send/audio`,
   `/send/video`. v1's entire messaging requirement needs zero engine work.

## Decision

**gowa is the v1 engine, running unmodified on container loopback.**

Specifically, and departing from [ADR-0006](0006-unix-socket-transport.md) for
v1: no Unix socket, no patches, **no fork**. gowa runs on `127.0.0.1:3100`
inside the container; bunwa is the only thing that can reach it, and the only
exposed port is bunwa's own. The `/ws` lifecycle bridge works again, because the
Bun WebSocket limitation only applied to socket files.

Calls are ignored by leaving `WHATSAPP_AUTO_REJECT_CALL` at its default of
false, and by excluding `call.offer` from the default event filter.

The Baileys engine is **promoted from optional to planned**, to start once the
control plane is live, against the triggers listed in
[11](../11-engine-decision.md).

## Consequences

**Good**

- Zero engine work for v1's messaging requirement
- No fork; upgrading the engine is `docker pull`
- whatsmeow's release cadence covers the OTP path during the riskiest period
- The `/ws` bridge survives, so lifecycle events need no gowa change and **no
  fork is required for v1**
- Ships as one container immediately

**Bad**

- Two runtimes in one image, and a supervisor (`s6-overlay`) to order and
  restart them
- Image size grows by gowa's Go binary
- A dependency on an upstream roadmap you do not control
- gowa keeps its own SQLite device store alongside bunwa's Postgres — two
  sources of truth about a device, reconciled by the adapter rather than by a
  constraint
- `/ws` is an internal, unversioned channel; a gowa upgrade may change its
  broadcast codes without notice. Mitigated by treating it as an optimisation
  over the status poller and contract-testing it in CI
  ([05](../05-events-and-rules.md))
- The colocated topology hosts one engine pool, so it does not scale past that
  pool's device count ([ADR-0003](0003-process-isolation.md))

**Deferred, not abandoned:** the Unix socket transport and the three gowa
patches from [ADR-0006](0006-unix-socket-transport.md) remain worthwhile, and
should be pursued as upstream pull requests rather than as a maintained fork.
