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
  ([ADR-0003](adr/0003-process-isolation.md)). *This one no longer holds as
  written: since stage 4 the engine is in the control plane's process. The note
  at the end of that ADR says what survived and what did not.*
- The control plane — the part with the actual product value — can be built,
  tested and shipped while the engine remains gowa. *It was, and that is why
  replacing gowa later cost fourteen lines outside its own directory.*

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
| `src/stores/` | Projects, environments, devices, virtual devices, consent workflow — planned as `src/tenancy/`, which never existed |
| `src/engine/` | `DeviceEngine` interface + adapters (`baileys/`, `fake`) + conformance suite |
| `src/events/` | Normalisation, the internal bus, subscriptions |
| `src/rules/` | Trigger matching and action execution |
| `src/delivery/` | Outbound webhooks, retry, DLQ, SSE hubs |
| `src/db/` | Drizzle schema, migrations, the connection — planned as `src/store/` |
| `src/console/` | The React SPA, served at `/app` by this same app ([07](07-dashboard.md)) |
| `src/observability/` | Logging, metrics, tracing, correlation ids |
| `src/config/` | Typed, validated environment configuration |

## The `DeviceEngine` interface

This is the most important contract in the system. It had to be expressible by
*both* an HTTP client talking to gowa *and* an in-process Baileys socket — which
is precisely the constraint that kept it honest, and is why the pivot in stage 4
was a directory rather than a rewrite. Only the second of those implementations
still exists; the constraint is preserved anyway, because the next engine will
not be in-process either.

```ts
/** A single WhatsApp identity as the control plane sees it. */
export interface DeviceEngine {
  /** Stable engine identifier: "baileys" | "fake". */
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
plane must never contain an `if (engine === "baileys")`. It does not, and this
is enforced rather than intended: the pairing route names no engine at all —
it asks the registry for any pool with capacity, and preference is registration
order decided in the composition root. The earlier version asked for `"gowa"`
by name and fell back to `"fake"`, which made adding an engine an edit to an
API route.

### Adapter responsibilities

| | gowa adapter *(stage 1–4, deleted)* | Baileys adapter *(the engine)* |
| --- | --- | --- |
| Transport | HTTP over TCP on container loopback — the Unix socket in [ADR-0006](adr/0006-unix-socket-transport.md) was deferred and never built | In-process socket, behind `src/engine/baileys/socket.ts` |
| Lifecycle events | `/ws` bridge + poll `/devices/{id}/status`, reconcile, synthesise | Emitted directly from Baileys connection events |
| Send | `POST /send/*`, mapped from `SendAction` | Baileys `sendMessage`, via the port |
| Failure isolation | Container per pool | **None at the process level** — see [ADR-0003](adr/0003-process-isolation.md) |
| Status of the port | Delivered in stage 1, removed in stage 4 | Delivered in stage 4 |

The right-hand column was written as "native adapter (later), stage 4,
optional". It is worth leaving the shape of that prediction visible: the column
that was optional is the only one left.

### Conformance suite

A single test suite runs against *every* adapter. It is the contract's teeth, and
it is what makes the eventual native engine a measurable swap rather than a leap
of faith. Written in stage 1 against the gowa adapter, so that on the day the
native adapter exists, "is it ready?" already has a numeric answer.

It worked. The Baileys adapter inherited eight behavioural guarantees the day it
compiled, and the suite still runs against both surviving engines — Baileys and
`FakeEngine`, which is not a placeholder for a missing engine but the reason the
control plane is testable without a phone.

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

*Revised after stage 4. The layout below described a separate `dashboard/`
subproject, a `reference/gowa/` clone and a `deploy/` directory of Dockerfiles
and s6 service definitions. All three are gone.*

```
bunwa/
├── src/                  everything — control plane, engine, console
│   ├── engine/baileys/   the only code that touches WhatsApp
│   └── console/          React SPA, served at /app by the same app
├── docs/                 you are here
└── Dockerfile            one image, two targets
```

Engines no longer run as separate containers or worker processes. Stage 4
replaced the gowa adapter with Baileys sockets held **in this process**, so the
data plane and the control plane share a runtime. `deploy/`, the s6 supervisor
and the compose stack existed to order and restart two processes; with one
process there is nothing to order.

This is the part of the architecture that changed most, and it changed the
meaning of a decision rather than reversing it: `enginePoolId` and
`ENGINE_POOL_CAPACITY` still bound how many devices a pool holds, but a pool is
no longer a process boundary, so what the bound protects is different. See
[ADR-0003](adr/0003-process-isolation.md), which is annotated rather than
rewritten. [10](10-single-container.md) and
[ADR-0006](adr/0006-unix-socket-transport.md) explored colocating two processes
over a socket file; with one process the question does not arise.
