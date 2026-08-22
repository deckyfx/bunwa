# 02 — Requirements

## The problem in one paragraph

You operate several independent products, each with its own database and its own
users. Every one of them needs to send and receive WhatsApp messages on behalf of
customers, using the customers' own numbers. Today each product runs its own gowa
instance, so a customer subscribed to three products must scan three QR codes and
keep three sessions alive on one phone. That is fragile, confusing, and it burns
the customer's device-link slots. bunwa exists to make a device something a
customer pairs **once** and then grants to projects individually.

## Functional requirements

### F1 — Tenancy

| ID | Requirement |
| --- | --- |
| F1.1 | A **Project** (e.g. `grande`) is a first-class entity; its display name is shown to customers |
| F1.2 | A Project has N **Environments** (`development`, `staging`, `production`), each with its own API keys, webhook, settings and quotas |
| F1.3 | Every API call is authenticated by an environment-scoped API key; project and environment are *derived*, never supplied |
| F1.4 | A **Device** is **system-owned and global**, identified by its phone number. It belongs to no project. |
| F1.5 | A **Virtual Device** binds one environment to one device, with its own alias, scopes, filters and webhook override |
| F1.6 | Many-to-many throughout: one device may serve N environments across N projects; one environment may hold N virtual devices |
| F1.7 | An environment can never observe another environment's traffic, including sibling environments of the same project |

F1.7 is deliberate. `development` sharing a physical device with `production`
must not mean development sees production's messages.

### F2 — Consent

| ID | Requirement |
| --- | --- |
| F2.1 | A project requesting a device already paired for **another project** MUST NOT gain access until the phone holder confirms |
| F2.2 | Consent is granted **per (device, project)**; all environments of that project inherit it |
| F2.3 | Confirmation is requested by sending a WhatsApp message to the number itself, carrying a single-use challenge token |
| F2.4 | A reply to that challenge is the primary approval channel; the dashboard is a secondary one |
| F2.5 | Consent can be revoked at any time, immediately, without disturbing the device's other projects |
| F2.6 | Consent requests expire (default 24h) rather than lingering |
| F2.7 | Every consent decision is written to an immutable audit log, including the replying JID and message id |

F2.2 is the friction decision. The customer agrees to *"Grande"*, not to
*"Grande's staging environment"*. Asking once per project rather than once per
environment is the difference between a smooth onboarding and three
confirmation messages to onboard one product.

### F3 — Device lifecycle

| ID | Requirement |
| --- | --- |
| F3.1 | Pair a device via QR code and via pairing code |
| F3.2 | Stream pairing progress to the requesting client in real time (SSE) |
| F3.3 | Emit `device.*` lifecycle events to every linked project's webhook — **the gap that started this project** |
| F3.4 | Distinguish *logged out* (slot kept) from *deleted* (purged), as gowa does |
| F3.5 | Reconnect automatically with bounded exponential backoff |
| F3.6 | Report per-device health: connection state, last-seen, backlog depth, error rate |
| F3.7 | One device failing must never affect another device, or another project |

### F4 — Messaging

**v1 message scope — deliberately small:**

| ID | Type | Send | Receive |
| --- | --- | --- | --- |
| F4.1 | Plain text (OTP is the primary case) | ✅ | ✅ |
| F4.2 | Image | ✅ | ✅ |
| F4.3 | PDF / document | ✅ | ✅ |
| F4.4 | URL with image preview | ✅ | ✅ |
| F4.5 | Audio | ✅ | ✅ |
| F4.6 | Video | ✅ | ✅ |

| ID | Requirement |
| --- | --- |
| F4.7 | All six types normalised to one stable inbound schema, identical regardless of engine |
| F4.8 | Idempotent sends: a client-supplied key must never produce a duplicate message |
| F4.9 | Per-virtual-device rate limiting and quotas, enforced before the engine is touched |
| F4.10 | Media validated on the way in: type, size, and page count for PDFs |

F4.8 matters most for OTP. A send that times out at the HTTP layer but succeeded
at WhatsApp must not become two codes in the customer's chat.

**Deferred, not rejected:** stickers, locations, contacts, polls, reactions,
replies, message editing, revoke, forward, star, group management, presence and
typing. All exist in gowa and can be surfaced when a project needs them; none is
in v1's critical path.

### F4b — Calls: do nothing

| ID | Requirement |
| --- | --- |
| F4b.1 | bunwa MUST NOT answer an incoming call |
| F4b.2 | bunwa MUST NOT reject an incoming call |
| F4b.3 | `call.offer` is excluded from the default event filter; a project may opt in for information only |

The customer's real phone must handle calls normally. A companion session does
not intercept them — the offer rings on every linked device — so the correct
implementation is inaction, not a "pass through" feature. In gowa this means
leaving `WHATSAPP_AUTO_REJECT_CALL` unset, which is already the default
([11](11-engine-decision.md)).

### F5 — Events and triggers

| ID | Requirement |
| --- | --- |
| F5.1 | One normalised event schema, versioned, engine-independent |
| F5.2 | Fan out each event to every virtual device entitled to see it, applying that binding's filters |
| F5.3 | Durable delivery: at-least-once, with retry, exponential backoff and a dead-letter queue |
| F5.4 | HMAC-signed payloads with a per-environment secret and a replay-resistant timestamp |
| F5.5 | Rule engine: match on device, sender, chat type, direction, content pattern, time window |
| F5.6 | Rule actions: reply, forward to a specific endpoint, tag, suppress, call an internal handler |
| F5.7 | Rules are per virtual device, versioned, and testable against a sample event without sending anything |
| F5.8 | SSE stream per project for live dashboards |

F5.7's dry-run requirement is deliberate. A rule engine you cannot test without
messaging a real customer is a rule engine nobody will dare change.

### F6 — Operations

| ID | Requirement |
| --- | --- |
| F6.1 | Structured JSON logs, correlation id propagated across the whole request path |
| F6.2 | Prometheus-compatible metrics: per device, per environment, per virtual device |
| F6.3 | Health and readiness endpoints suitable for a container orchestrator |
| F6.4 | Configuration from environment, validated and typed at boot — fail fast on a bad value |
| F6.5 | Ship **two container tags from one build**: `api` (control plane + engine) and `full` (adds the dashboard) |
| F6.6 | The dashboard is a **separate subproject** with its own build, absent from the `api` image |
| F6.7 | A single `docker run` plus Postgres and Redis must be enough to start |

## Non-functional requirements

| ID | Requirement | Target |
| --- | --- | --- |
| N1 | Send API latency (excluding WhatsApp itself) | p95 < 100 ms |
| N2 | Inbound event → webhook dispatched | p95 < 500 ms |
| N3 | Devices per node | ≥ 100 (validate early; see [01](01-gowa-architecture.md) open question 2) |
| N4 | Control-plane availability | 99.5% |
| N5 | Event loss | Zero, once accepted — durability over latency |
| N6 | Blast radius of one device failure | That device only |
| N8 | OTP send accepted → delivered to WhatsApp | p95 < 2 s |
| N7 | Cold start to all devices reconnected | < 60 s |

## Explicitly out of scope

Saying no here is what keeps the project finishable. Each of these is a real
product in its own right.

| Not building | Why |
| --- | --- |
| Chat history storage and search | gowa spends 3.9k lines on this. bunwa is a proxy; the projects own their data and already have databases. |
| Chatwoot / helpdesk integration | 6.4k lines in gowa. Build it as a *consumer* of bunwa's webhooks if you want it. |
| A CRM, inbox, or agent UI | The dashboard administers devices and links. It is not an inbox. |
| Broadcast and campaign management | Ban risk, and a different product. Projects can drive it through the API. |
| Meta Cloud API support | Different auth, different pricing, different capabilities. Possibly a future engine adapter; not now. |
| Chat storage endpoints (`/chats`, `/chat/{jid}/messages`) | Follows from the first row |

## Compatibility stance

bunwa's message-send and group endpoints **should** stay recognisably close to
gowa's request and response shapes, so that existing gowa integrations port with
minimal effort and so the OpenAPI spec at
[`reference/gowa/docs/openapi.yaml`](../reference/gowa/docs/openapi.yaml) can
serve as a checklist.

bunwa's device, tenancy and event surfaces **will** diverge, because gowa's are
single-tenant by construction. Do not contort the design for wire compatibility
that cannot be achieved anyway — see [06](06-api-design.md).
