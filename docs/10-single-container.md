# 10 — Single container, Unix socket transport

*Explores: "can bunwa and gowa live in one container, talking over a socket file
instead of a TCP port?"*

## Short answer

**Yes — mostly, and with one hard limitation I verified rather than assumed.**

| Direction | Mechanism | Status |
| --- | --- | --- |
| gowa listens on a socket file | Fiber v3 `ListenerNetwork: NetworkUnix` | ✅ **One-line change** |
| bunwa → gowa, HTTP | `fetch(url, { unix })` | ✅ Verified working |
| gowa → bunwa, webhooks | `Bun.serve({ unix })` + a Go unix dialler | ✅ ~10-line gowa patch |
| bunwa → gowa, WebSocket `/ws` | `new WebSocket(url, { unix })` | ❌ **Not supported by Bun** |

The WebSocket gap turns out to be a blessing: routing around it forces the design
that was better anyway.

## Evidence

### gowa can listen on a Unix socket — trivially

[`src/cmd/rest.go:193`](../reference/gowa/src/cmd/rest.go) today:

```go
listenErr <- app.Listen(config.AppHost+":"+config.AppPort, fiber.ListenConfig{ListenerNetwork: "tcp"})
```

Fiber v3 supports Unix domain sockets natively, and — unlike v2 — handles stale
socket removal and file permissions itself. The patch is one line:

```go
if config.AppSocket != "" {
    listenErr <- app.Listen(config.AppSocket, fiber.ListenConfig{
        ListenerNetwork:    fiber.NetworkUnix,
        UnixSocketFileMode: 0o660,
    })
} else {
    listenErr <- app.Listen(config.AppHost+":"+config.AppPort, fiber.ListenConfig{ListenerNetwork: "tcp"})
}
```

Plus one config field. This is about as small as a fork gets, and it is
upstreamable as a clean feature PR.

### Bun speaks HTTP over Unix sockets — both directions

Verified empirically in this repository, not taken from documentation:

```ts
const server = Bun.serve({ unix: SOCK, fetch: () => new Response("http-ok") });
const r = await fetch("http://localhost/", { unix: SOCK });
// → "http-ok"
```

Both `Bun.serve({ unix })` and `fetch(url, { unix })` work. Note the URL's host
is ignored when `unix` is set; it is required syntactically only.

### Bun cannot open a WebSocket over a Unix socket

Also verified empirically. Against a `Bun.serve({ unix })` that upgrades
correctly:

```ts
new WebSocket("ws://localhost/ws", { unix: SOCK } as any);
// → WebSocket connection to 'ws://localhost/ws' failed: Expected 101 status code
```

The `unix` option is silently ignored; the client dials TCP `localhost:80` and
fails there. `fetch` supports `unix`; `WebSocket` does not.

**Consequence:** if gowa listens *only* on a socket file, the `/ws` bridge
described in [05](05-events-and-rules.md) cannot work. Something has to change.

## Routing around the WebSocket gap

Four options. The third is the one to take.

| # | Approach | Verdict |
| --- | --- | --- |
| 1 | gowa listens on both a socket and loopback TCP; `/ws` over TCP | Works, but two transports for one dependency — the socket then buys nothing |
| 2 | `socat UNIX-CONNECT:… TCP-LISTEN:…` sidecar bridging `/ws` | Works; adds a process and a failure mode to save a patch |
| 3 | **Patch gowa to emit lifecycle events as webhooks; drop `/ws` entirely** | ✅ **Recommended** |
| 4 | `Bun.connect({ unix })` and hand-roll the WebSocket handshake and framing | Do not |

Option 3 is the fix that was already identified as worth contributing upstream in
[05](05-events-and-rules.md). Doing it now means:

- The transport becomes **HTTP over Unix in both directions**, uniformly
- The adapter loses its `/ws` client — less code, fewer states
- Lifecycle events gain retry semantics, because they travel the webhook path
- The patch benefits every gowa user, so it can go upstream and the fork can
  eventually disappear

The status poller and reconciler stay regardless: they cover gowa itself dying,
which no in-band event can report.

## The three patches

All small, all localised, all independently upstreamable.

| # | File | Size | Purpose |
| --- | --- | --- | --- |
| 1 | [`src/cmd/rest.go:193`](../reference/gowa/src/cmd/rest.go) | ~8 lines | Listen on a Unix socket when configured |
| 2 | [`src/infrastructure/whatsapp/webhook.go:34`](../reference/gowa/src/infrastructure/whatsapp/webhook.go) | ~12 lines | Dial `unix://` webhook targets |
| 3 | `event_handler.go` + `webhook_forward.go` | ~100 lines | Forward lifecycle events to webhooks |

### Patch 2, in detail

gowa builds its webhook client in exactly one place, `submitWebhook`:

```go
transport := &http.Transport{
    TLSClientConfig: &tls.Config{InsecureSkipVerify: insecureSkipVerify},
}
```

Teaching it to dial a socket is a prefix check:

```go
// unix:///run/bunwa/bunwa.sock:/hooks/gowa
if sockPath, httpPath, ok := parseUnixWebhookURL(url); ok {
    transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
        return (&net.Dialer{}).DialContext(ctx, "unix", sockPath)
    }
    url = "http://localhost" + httpPath
}
```

Everything downstream — HMAC signing, timeouts, retries, per-device config — is
untouched.

### Patch 3, worth doing anyway

While in `event_handler.go`, also fix this
([line 306](../reference/gowa/src/infrastructure/whatsapp/event_handler.go)):

```go
func handleStreamReplaced(_ context.Context) {
    os.Exit(0)
}
```

In a colocated container this kills gowa and every device it holds. Replace it
with a per-device teardown plus a `device.stream_replaced` event. Three lines,
and it materially changes how safe colocation is.

## Recommended topology

```
┌─────────────────────────── one container ───────────────────────────┐
│                                                                      │
│  ┌────────────────┐                          ┌───────────────────┐  │
│  │ bunwa (Bun)    │                          │ gowa (Go)         │  │
│  │                │  fetch({unix}) ───────▶  │ /run/gowa.sock    │  │
│  │ Bun.serve      │  ◀─── webhook POST       │                   │  │
│  │ ({unix:        │       unix:// dialler    │ patched: unix     │  │
│  │  bunwa.sock})  │                          │ listen + dial     │  │
│  │                │  poll /devices/*/status  │                   │  │
│  └───────┬────────┘                          └───────────────────┘  │
│          │ :3000 (the only exposed port)                            │
│          ▼                                                          │
│      ingress                     supervisor: s6-overlay             │
│                                  /run: tmpfs, mode 0770             │
└──────────────────────────────────────────────────────────────────────┘
             │                              │
      Postgres, Redis              project webhooks
```

**No TCP port is open for gowa at all** — not even on loopback. That is the real
win over the "just bind 127.0.0.1" alternative: with a socket file, gowa is
unreachable from anything that cannot open that inode, so filesystem permissions
become the access control. Combined with running the two processes as different
users sharing a group, that is a meaningfully stronger boundary than a loopback
port any process in the namespace can connect to.

Practical notes:

- Put the socket directory on a `tmpfs` so no stale socket survives a restart.
- Use a real supervisor. `s6-overlay` handles the ordering (gowa first, then
  bunwa), restarts each independently, and reaps zombies. A shell script with
  `&` and `wait` does none of that well.
- bunwa must tolerate the socket being absent at boot and reconnect — gowa may
  still be starting.
- Health check the container on bunwa only; bunwa reports engine health.

## What colocation costs

Be clear-eyed: this partially reverses
[ADR-0003](adr/0003-process-isolation.md).

| Property | Separate containers | Single container |
| --- | --- | --- |
| Independent restart | ✅ Orchestrator | ⚠️ Supervisor only |
| Independent scaling | ✅ | ❌ Scale both or neither |
| Blast radius | Pool-sized | Container-sized |
| Rolling engine upgrade | ✅ | ❌ Restarts everything |
| Multiple engine pools | ✅ | ❌ One pool per container |
| Network hop | Container network | Kernel socket — measurably faster |
| Attack surface | Port on a network | Socket inode, filesystem-permissioned |
| Deployment complexity | Compose or Kubernetes | One image |

The isolation loss is real but bounded, provided patch 3 lands and the
supervisor restarts gowa independently. What you cannot do in this topology is
run several engine pools — so it does not scale past one pool's worth of
devices.

## The resolution: transport is configuration, topology is deployment

This does not need to be an either/or, and the architecture in
[03](03-architecture.md) already accommodates both. The gowa adapter takes a
transport descriptor:

```ts
type GowaTransport =
  | { kind: "unix"; socket: string }
  | { kind: "tcp";  baseUrl: string };
```

Everything above that line — reconciler, normalisation, send mapping — is
identical. So:

| Deployment | Topology | Transport |
| --- | --- | --- |
| Local development | Single container | Unix socket |
| Small / single-tenant | Single container | Unix socket |
| Production, multi-pool | Separate containers | TCP within the pool network |

Ship the single-container image as the default developer and small-deployment
experience — it is genuinely nicer, one `docker run`, no exposed engine port —
and keep the split topology for scale. The decision then costs nothing to
revisit, because it is a config value rather than an architecture.

See [ADR-0006](adr/0006-unix-socket-transport.md).
