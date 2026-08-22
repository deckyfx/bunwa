# ADR-0006 — Unix socket transport, and a colocated single-container option

**Status:** Accepted · 2026-08-22

## Context

Running bunwa and gowa as two containers is operationally correct but heavy for
development and for small single-tenant deployments. The proposal was to
colocate them in one container and have them communicate over a socket file
rather than a TCP port, so that no engine port is exposed at all.

Three facts, established by testing rather than assumption
([10](../10-single-container.md)):

1. Fiber v3 supports Unix domain sockets natively via
   `ListenConfig{ListenerNetwork: NetworkUnix}`, and manages socket file removal
   and permissions itself. gowa's change is one line at `src/cmd/rest.go:193`.
2. Bun supports HTTP over Unix sockets in both directions —
   `Bun.serve({ unix })` and `fetch(url, { unix })`. Verified working.
3. **Bun's `WebSocket` client does not support Unix sockets.** The `unix` option
   is ignored and the client dials TCP. Verified failing.

Fact 3 breaks the `/ws` bridge that the gowa adapter was specified to use for
lifecycle events.

## Decision

**Adopt Unix socket transport, and drop the `/ws` bridge in favour of patching
gowa to emit lifecycle events as webhooks.**

The gowa adapter takes a transport descriptor — `{kind:"unix", socket}` or
`{kind:"tcp", baseUrl}` — and is otherwise identical in both modes. Transport
becomes configuration; single-container versus split-container becomes a
deployment topology rather than an architectural choice.

Three patches are maintained against gowa, each independently upstreamable:

1. Listen on a Unix socket when configured (~8 lines)
2. Dial `unix://` webhook targets (~12 lines)
3. Forward lifecycle events to webhooks, and replace `os.Exit(0)` on
   `StreamReplaced` with per-device teardown (~100 lines)

Patch 3 was already identified as desirable in [05](../05-events-and-rules.md);
fact 3 promotes it from optional to load-bearing.

The single-container image is the default for development and small
deployments. The split topology remains the production default at scale.

## Consequences

**Good**

- No engine port is exposed anywhere, not even loopback; access control becomes
  filesystem permissions, which is a stronger boundary than a port in a shared
  network namespace
- One image, one `docker run` for development and small deployments
- Kernel-socket transport is faster than a container network hop
- Dropping the `/ws` client removes a whole class of adapter state
- Lifecycle events inherit the webhook path's retry semantics
- All three patches benefit upstream, so the fork may be temporary

**Bad**

- A gowa fork must be maintained until the patches are upstreamed. Mitigated by
  their size and locality — three files, ~120 lines total.
- The single-container topology partially reverses
  [ADR-0003](0003-process-isolation.md): one container, one engine pool,
  container-sized blast radius, no rolling engine upgrade. Bounded by patch 3
  and by an independent supervisor, but real.
- The single-container topology cannot host multiple engine pools, so it does
  not scale past one pool's worth of devices.
- Requires a supervisor (`s6-overlay`) and a tmpfs socket directory —
  incidental, but it is complexity that a single-process image would not have.

**Rejected alternatives**

- *Loopback TCP inside the container.* Zero patches, but any process in the
  namespace can reach the engine, and the isolation benefit — the actual point
  of the exercise — is lost.
- *`socat` bridging `/ws`.* Adds a process and a failure mode purely to avoid a
  patch that is worth making anyway.
- *Hand-rolled WebSocket over `Bun.connect({ unix })`.* Implementing RFC 6455
  framing to avoid a 100-line Go patch is a poor trade.
