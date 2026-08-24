# 03 — Architecture

## The central idea

**bunwa is a control plane. It holds no WhatsApp sockets.**

Everything that speaks the WhatsApp protocol lives behind a `DeviceEngine`
interface in a separate process. Everything that knows about projects, owners,
consent, rules and delivery lives in bunwa and knows nothing about protobuf
frames.

That single split is what makes the whole plan tractable:

- The Go → Bun migration becomes a per-device engine swap instead of a big-bang
  rewrite ([ADR-0002](adr/0002-engine-adapter.md)).
- A crashing engine takes down its devices only, never the control plane
  ([ADR-0003](adr/0003-process-isolation.md)).
- The control plane — the part with the actual product value — can be built,
  tested and shipped while the engine remains gowa.

## System view

```
                            ┌───────────────────────────────┐
   project-a ──── API key ─▶│                               │
   project-b ──── API key ─▶│         bunwa control plane   │
   project-c ──── API key ─▶│            (Bun / Elysia)     │
                            │                               │
                            │  ┌─────────────────────────┐  │
   owner ─── dashboard ────▶│  │ auth · tenancy · consent│  │
                            │  ├─────────────────────────┤  │
                            │  │ routing · quota · idem. │  │
                            │  ├─────────────────────────┤  │
                            │  │ event bus · rules       │  │
                            │  ├─────────────────────────┤  │
                            │  │ delivery (retry · DLQ)  │  │
                            │  └─────────────────────────┘  │
                            └───┬──────────────┬────────────┘
                    DeviceEngine│              │DeviceEngine
                       (adapter)│              │(adapter)
                            ┌───▼────┐    ┌────▼──────────┐
                            │  gowa  │    │ native engine │
                            │ engine │    │  (Baileys)    │
                            │ pool   │    │   later       │
                            └───┬────┘    └────┬──────────┘
                                │              │
                            ┌───▼──────────────▼───┐
                            │   WhatsApp servers   │
                            └──────────────────────┘

        ┌───────────────────────────┐   ┌─────────────────┐
        │ SQLite                    │   │ project webhooks│
        │ state + delivery queue    │   │ (fan-out target)│
        └───────────────────────────┘   └─────────────────┘
```

## Modules

Each becomes a directory under `src/`. The dependency rule is one-directional:
`api → core → engine`, never the reverse.

| Module | Responsibility |
| --- | --- |
| `src/api/` | HTTP surface — Elysia routes, DTOs, validation, OpenAPI generation |
| `src/auth/` | Project API keys, owner sessions, scope checks |
| `src/tenancy/` | Projects, environments, devices, virtual devices, consent workflow |
| `src/engine/` | `DeviceEngine` interface + adapters (`gowa/`, `native/`) + conformance suite |
| `src/events/` | Normalisation, the internal bus, subscriptions |
| `src/rules/` | Trigger matching and action execution |
| `src/delivery/` | Outbound webhooks, retry, DLQ, SSE hubs |
| `src/store/` | Drizzle schema, migrations, repositories |
| `src/observability/` | Logging, metrics, tracing, correlation ids |
| `src/config/` | Typed, validated environment configuration |

## The `DeviceEngine` interface

This is the most important contract in the system. It must be expressible by
*both* an HTTP client talking to gowa *and* an in-process Baileys socket — which
is precisely the constraint that keeps it honest.

```ts
/** A single WhatsApp identity as the control plane sees it. */
export interface DeviceEngine {
  /** Stable engine identifier, e.g. "gowa" | "native". */
  readonly kind: EngineKind;

  /** Provision a slot. Idempotent on deviceId. */
  provision(deviceId: DeviceId): Promise<DeviceHandle>;

  /** Begin pairing. Emits device.qr / device.pair_code until resolved. */
  startPairing(deviceId: DeviceId, method: PairingMethod): Promise<PairingSession>;

  /** Log out, keeping the slot and any engine-side history. */
  logout(deviceId: DeviceId): Promise<void>;

  /** Destroy the slot and its credentials. Irreversible. */
  purge(deviceId: DeviceId): Promise<void>;

  /** Current state; cheap enough to poll on a health interval. */
  status(deviceId: DeviceId): Promise<DeviceStatus>;

  /** Perform an outbound action. One method, discriminated union payload. */
  send(deviceId: DeviceId, action: SendAction): Promise<SendResult>;

  /**
   * Hot stream of already-normalised events for every device this engine owns.
   * Adapters are responsible for synthesising lifecycle events the underlying
   * implementation does not emit natively.
   */
  subscribe(): AsyncIterable<NormalisedEvent>;
}
```

Two design notes:

**`send` is one method, not twelve.** A discriminated `SendAction` union keeps
the interface stable as message types are added, and keeps adapters from
drifting apart in method coverage. Adding `send/poll` should be a new union
member and a conformance test, not an interface change.

**`subscribe` returns normalised events, not raw ones.** Normalisation is the
adapter's job, because only the adapter knows its source format. The control
plane must never contain an `if (engine === "gowa")`.

### Adapter responsibilities

| | gowa adapter | native adapter (later) |
| --- | --- | --- |
| Transport | HTTP over a Unix socket (colocated) or TCP (split) — see [ADR-0006](adr/0006-unix-socket-transport.md) | In-process Baileys socket |
| Lifecycle events | Patched gowa webhooks + poll `/devices/{id}/status`, reconcile, synthesise | Emit directly from Baileys connection events |
| Send | `POST /send/*`, mapped from `SendAction` | Baileys `sendMessage` |
| Failure isolation | Container per pool | Worker process per pool |
| Status of the port | **Stage 1 deliverable** | **Stage 4, optional** |

### Conformance suite

A single test suite runs against *every* adapter. It is the contract's teeth, and
it is what makes the eventual native engine a measurable swap rather than a leap
of faith. Written in stage 1 against the gowa adapter, so that on the day the
native adapter exists, "is it ready?" already has a numeric answer.

## Blast radius

gowa's `handleStreamReplaced → os.Exit(0)` is the cautionary tale
([01](01-gowa-architecture.md)). bunwa's containment strategy, in layers:

| Layer | Isolation |
| --- | --- |
| Control plane ↔ engine | Separate processes. An engine crash is an adapter reconnect, never a control-plane restart. |
| Engine pools | N devices per pool (start with 25). A pool crash affects those N. |
| Device | A device error transitions that device's state machine; siblings untouched. |
| Project | Per-virtual-device quotas and circuit breakers. A project hammering the API cannot starve another. |
| Delivery | Per-virtual-device delivery queues. A dead webhook backs up its own queue and nothing else. |

That last row is easy to skip and expensive to retrofit. One shared retry queue
means one unresponsive customer endpoint delays everyone's events.

## Data flow: inbound message

```
WhatsApp → engine → adapter normalises → NormalisedEvent{deviceId, ...}
                                              │
                                    resolve virtual devices for device
                                              │
                              ┌───────────────┼───────────────┐
                          link A          link B          link C
                        (project-a)     (project-b)     (revoked ✗)
                              │               │
                    scope + JID + event filter per virtual device
                              │               │
                        rule engine     rule engine
                              │               │
                    ┌─────────┴──┐            │
                 webhook       action      webhook
                 (queued,     (reply,     (queued)
                  retried)    tag, …)
```

The critical property: **the same physical message becomes N independent
deliveries**, each filtered and transformed by its own binding's configuration, each
retried on its own queue. Project B's outage cannot delay project A.

## Data flow: outbound send

```
POST /v1/messages  (X-API-Key: project-a)
   │ authenticate → project
   │ resolve virtual device (environment, device) → must be ACTIVE
   │ scope check → binding must grant `send:text`
   │ idempotency key → return prior result if replayed
   │ quota + rate limit → per virtual device
   ▼
engine.send(deviceId, action)
   │
   ▼ persist outbound record, emit `message.sent`
```

Every one of those gates is missing in gowa, because in a single-tenant gateway
they are unnecessary. In a shared one they are the product.

## Technology choices

| Concern | Choice | Rationale |
| --- | --- | --- |
| Runtime | Bun (latest) | Project premise; fast startup, native TS, single-executable builds |
| HTTP | Elysia | End-to-end types with Eden Treaty, first-class OpenAPI, mature on Bun |
| Database | **SQLite + Drizzle** for stage 1; Postgres when a second process needs the data — see [ADR-0005](adr/0005-postgres-over-sqlite.md) | No server to stand up, and tests run against a real database rather than synthetic rows |
| Queues | A SQLite table | Durable per-virtual-device delivery queues with a visible backlog. One process owns the data, so a queue that needs no server is the smaller system — see [ADR-0005](adr/0005-postgres-over-sqlite.md) |
| Realtime → dashboard | SSE | One-way, survives proxies, far simpler than WebSocket for this shape |
| Validation | TypeBox via Elysia | One schema drives validation, types and OpenAPI |
| Tests | `bun test` | Native, fast; conformance suite runs per adapter |

Postgres over SQLite is a deliberate departure from gowa. gowa's SQLite default
is right for a single binary owning its own devices; bunwa has multiple engine
pools and a control plane that all need consistent, concurrent access to the
same binding and consent state.

## What lives where

```
bunwa/
├── src/                  control plane            → image tag  bunwa:api
├── dashboard/            React SPA, separate build → image tag  bunwa:full
├── docs/                 you are here
├── reference/gowa/       read-only upstream, git-ignored
└── deploy/               Dockerfiles, s6 service definitions, compose files
```

For v1 the gowa engine is colocated in the same image on container loopback,
unmodified — see [ADR-0007](adr/0007-gowa-engine-for-v1.md). Split-container
deployment with multiple engine pools remains available and is the path for
scale.

Engines run as separate containers or worker processes, defined in `deploy/`,
never imported by the control plane. They may also be **colocated in a single
container** and reached over a Unix socket — the adapter takes a transport
descriptor, so this is a deployment choice rather than an architectural one.
See [10](10-single-container.md) and [ADR-0006](adr/0006-unix-socket-transport.md).
