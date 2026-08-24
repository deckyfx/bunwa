# 05 — Events and rules

This document covers limitations #1 and #2 from the project brief: lifecycle
events that never escape gowa, and the absence of any trigger engine.

## Part 1 — The event catalogue

### Normalised envelope

Every event, from every engine, has the same envelope. Consumers version against
`schema`, not against the engine.

```jsonc
{
  "schema": "bunwa.event/v1",
  "id": "evt_01J...",            // ULID, unique, stable across retries
  "type": "message.received",
  "occurred_at": "2026-08-22T10:15:00.123Z",
  "device": { "id": "dev_...", "jid": "628...@s.whatsapp.net", "label": "Front desk" },
  "project": { "id": "prj_...", "slug": "billing-app" },  // per-delivery
  "virtual_device": { "id": "vdev_...", "alias": "otp-sender" },  // per-delivery
  "environment": { "id": "env_...", "slug": "production" },       // per-delivery
  "data": { /* type-specific */ },
  "meta": { "engine": "gowa", "correlation_id": "..." }
}
```

`project`, `environment` and `virtual_device` are filled per delivery, not at normalisation. The same
physical event becomes N envelopes, one per entitled virtual device.

### Lifecycle events — the gap being closed

**None of these exist in gowa's webhook catalogue.** They are the reason this
project started.

| Type | Fires when | `data` |
| --- | --- | --- |
| `device.provisioned` | Slot created | `{}` |
| `device.qr` | QR generated or refreshed | `{ qr, expires_at }` |
| `device.pair_code` | Pairing code issued | `{ code, expires_at }` |
| `device.pairing_failed` | Pairing timed out or was rejected | `{ reason }` |
| `device.connected` | Socket up and authenticated | `{ jid, msisdn, push_name }` |
| `device.disconnected` | Socket lost, recovery expected | `{ reason, will_retry, retry_at }` |
| `device.logged_out` | **Unlinked from the phone. Slot kept.** | `{ reason: "remote_logout" \| "api" }` |
| `device.degraded` | Reconnect backoff exhausted; manual action needed | `{ attempts, last_error }` |
| `device.recovered` | Back to connected after degradation | `{ downtime_ms }` |
| `device.purged` | Slot destroyed | `{}` |
| `consent.requested` | A project asked to reuse an existing device | `{ project, scopes }` |
| `consent.granted` | Phone holder confirmed, by reply or dashboard | `{ project, channel, message_id }` |
| `consent.denied` | Phone holder declined | `{ project, channel }` |
| `consent.revoked` | Phone holder or operator revoked | `{ project, actor }` |
| `virtualdevice.activated` | Binding is live; this environment may send | `{ alias, scopes }` |
| `virtualdevice.suspended` | Quota breach or operator action | `{ reason }` |

`device.logged_out` is the specific event whose absence prompted this project.
When a customer unlinks their phone, every project holding an active binding learns
within seconds, over a signed, retried webhook.

### Message and chat events

Deliberately near-identical to gowa's names, so existing integrations port
cleanly. v1 emits `message.received` for the six supported types only
([02](02-requirements.md) F4); the rest are listed because gowa already produces
them and surfacing one later is a filter change, not a feature. See
[`reference/gowa/docs/webhook-payload.md`](../reference/gowa/docs/webhook-payload.md).

| Type | gowa equivalent |
| --- | --- |
| `message.received` | `message` |
| `message.sent` | — (new: confirms bunwa-originated sends) |
| `message.ack` | `message.ack` |
| `message.reaction` | `message.reaction` |
| `message.revoked` | `message.revoked` |
| `message.edited` | `message.edited` |
| `message.deleted` | `message.deleted` |
| `chat.presence` | `chat_presence` |
| `group.participants` | `group.participants` |
| `group.joined` | `group.joined` |
| `call.offer` | `call.offer` — **excluded from the default filter**; bunwa never answers or rejects ([02](02-requirements.md) F4b) |
| `newsletter.*` | `newsletter.*` |

## Part 2 — How the gowa adapter synthesises lifecycle events

gowa does not emit these. The adapter manufactures them from three sources, and
this is the mechanism that lets limitation #1 be fixed **without forking gowa**.

```
   ┌── gowa /ws (2 useful codes) ┐
   │ DEVICE_LOGGED_OUT           │──┐
   │ LOGIN_SUCCESS               │  │   ┌──────────────┐
   └─────────────────────────────┘  ├──▶│ reconciler   │──▶ device.* events
                                    │   │ (state m/c)  │
   ┌── poll /devices/{id}/status ──┐ │   └──────────────┘
   │ is_connected + is_logged_in   │─┤          ▲
   │ every 10s · SOURCE OF TRUTH   │ │          │
   └───────────────────────────────┘ │   compares observed
                                     │   vs last known state
   ┌── login response ─────────────┐ │
   │ qr_link, qr_duration          │─┤
   └───────────────────────────────┘ │
   ┌── adapter transport health ───┐ │
   │ HTTP errors, /ws drops        │─┘
   └───────────────────────────────┘
```

| Source | Gives you | Misses | Contract |
| --- | --- | --- | --- |
| gowa `/ws` | **Only** `DEVICE_LOGGED_OUT` and `LOGIN_SUCCESS` — instantly | Everything else. No QR, no connect, no disconnect. | **None — internal channel** |
| Status polling | `is_connected` + `is_logged_in` per device, every interval | Fast transitions between polls | Documented REST API |
| Login response | `qr_link`, `qr_duration` — QR is *not* broadcast | — | Documented REST API |
| Transport health | gowa itself being down | Individual device state | — |

The `/ws` row is much narrower than an earlier draft claimed — see
[12](12-stage0-findings.md) for the correction and the evidence. Note also that
`/devices` list `state` disagrees with `/devices/{id}/status`; only the latter
is trustworthy.

Together they cover the space.

**`/ws` is an optimisation, not a source of truth.** It is gowa's internal
dashboard channel: undocumented, unversioned, and free to change between
releases. The reconciler must therefore be built so that **polling alone is
sufficient** — `/ws` only makes transitions faster. If a gowa upgrade renames a
broadcast code, bunwa degrades from sub-second to one-poll-interval latency and
emits `engine.ws_desync`; it does not lose events. A contract test in CI asserts
the expected codes against the pinned gowa image so the degradation is noticed
deliberately rather than discovered in production. The reconciler owns the device state machine from
[04](04-data-model.md) and emits an event only on an actual transition — polling
must never produce duplicate events.

> **Superseded in part by [ADR-0006](adr/0006-unix-socket-transport.md).**
> Bun's `WebSocket` client cannot dial a Unix socket (verified — see
> [10](10-single-container.md)), so under the socket transport the `/ws` bridge
> is impossible. The decision is therefore to patch gowa to emit lifecycle
> events as webhooks and drop the `/ws` client entirely. The status poller and
> reconciler below stay either way — they are what covers gowa itself dying.
> The `/ws` bridge remains valid only for an unpatched gowa reached over TCP.

**Upstream contribution worth making:** adding lifecycle events to gowa's
webhook forwarder is perhaps 100 lines in
[`webhook_forward.go`](../reference/gowa/src/infrastructure/whatsapp/webhook_forward.go)
and `event_handler.go`. It would benefit every gowa user and reduce bunwa's
adapter complexity. Worth a pull request regardless of how far bunwa goes —
though the adapter should keep the reconciler anyway, since it also covers the
case of gowa itself dying.

## Part 3 — Fan-out and filtering

```
NormalisedEvent (device-scoped)
      │
      ▼  resolve active virtual devices for device        ← revoked bindings are invisible
      │
      ▼  per virtual device, in order:
      │     1. scope check      — does this binding's scopes permit this type?
      │     2. jid_allowlist    — if set, chat must be in it
      │     3. jid_denylist     — wildcards, as gowa
      │     4. event_filter     — explicit type whitelist
      │
      ▼  rule engine (per virtual device)
      │
      ▼  actions → delivery queue (per virtual device)
```

Filtering is applied **before** the rule engine, so a rule can never observe a
chat the link is not entitled to see. Getting that order wrong is a data leak.

## Part 4 — The rule engine

gowa's automation is one global static string
([`auto_reply.go`](../reference/gowa/src/infrastructure/whatsapp/auto_reply.go)).
This replaces it with something a project can actually configure.

### Rule shape

```jsonc
{
  "name": "Route payment confirmations to billing",
  "enabled": true,
  "priority": 10,
  "stop_on_match": true,
  "match": {
    "all": [
      { "field": "type",           "op": "eq",     "value": "message.received" },
      { "field": "data.from",      "op": "in",     "value": ["628123...@s.whatsapp.net"] },
      { "field": "device.jid",     "op": "eq",     "value": "628999...@s.whatsapp.net" },
      { "field": "data.text",      "op": "matches","value": "^PAY\\s+(?<ref>[A-Z0-9]{6,})$" },
      { "field": "data.chat_type", "op": "eq",     "value": "direct" },
      { "field": "occurred_at",    "op": "within", "value": { "tz": "Asia/Jakarta", "days": ["mon-fri"], "from": "08:00", "to": "17:00" } }
    ]
  },
  "actions": [
    { "type": "reply",   "template": "Received {{ match.ref }}, processing." },
    { "type": "forward", "url": "https://billing.internal/wa/payment", "include": ["match", "event"] },
    { "type": "tag",     "value": "payment" }
  ]
}
```

This is exactly the brief's example: *a message from a certain number, to a
certain number, containing a certain format → do something.* Sender is
`data.from`, recipient is `device.jid`, format is a named-capture regex, and the
captures are available to every action as `match.*`.

### Match operators

| Operator | Applies to | Notes |
| --- | --- | --- |
| `eq`, `neq` | any scalar | |
| `in`, `not_in` | scalar vs array | |
| `contains`, `starts_with`, `ends_with` | strings | Case-insensitive by default |
| `matches` | strings | **RE2 syntax only** — see below |
| `exists` | any | |
| `gt`, `gte`, `lt`, `lte` | numbers, timestamps | |
| `within` | timestamps | Timezone-aware business-hours windows |

Combinators: `all`, `any`, `none`, arbitrarily nested.

**Regex safety is not optional.** Project-supplied patterns run against every
inbound message. A catastrophically backtracking pattern is a denial of service
against every tenant on the node. Mitigations, all three:

1. Restrict to RE2 semantics (no backreferences, no lookaround) — linear time by
   construction.
2. Cap pattern length and compile once at rule-save time, rejecting invalid or
   over-complex patterns before they are ever stored.
3. Execute with a hard timeout, in a worker, and auto-disable a rule that
   repeatedly exceeds it.

### Actions

| Action | Behaviour |
| --- | --- |
| `reply` | Send a templated message back to the originating chat |
| `send` | Send to an explicit target |
| `forward` | POST to a URL other than the link's default webhook |
| `tag` | Attach a label to the event for downstream consumers |
| `suppress` | Stop this event from reaching the link's webhook |
| `set_var` | Store a value in link-scoped state for later rules |
| `noop` | Match without acting — for testing and metrics |

Guard predicates ported from gowa's auto-reply apply to every `reply` action
before it fires: never reply to groups, broadcasts, `status@`, or own messages,
unless the rule explicitly opts in. Those guards were learned the hard way
upstream and should not be re-learned here.

### Loop protection

Non-negotiable, because a rule that replies to a message can trivially trigger
another rule that replies to the reply:

- Events generated by bunwa carry `meta.origin: "bunwa"` and are excluded from
  rule matching by default.
- A per-chain depth counter, hard-capped at 3.
- Per-virtual-device reply rate limit (default 1 per chat per 10 s).
- A circuit breaker that disables a rule exceeding its firing budget and emits
  `rule.disabled`.

### Dry run

```
POST /v1/links/{id}/rules/{rule_id}/test
{ "event": { … a sample or a real captured event … } }

→ { "matched": true,
    "captures": { "ref": "AB1234" },
    "actions_planned": [ … ],
    "actions_executed": []   ← always empty
  }
```

Nothing is sent, ever. Requirement F5.7. A rule engine you cannot test against a
real captured event without messaging a live customer is a rule engine nobody
will touch.

## Part 5 — Delivery

A per-virtual-device queue in SQLite, drained by an in-process worker.

| Property | Value |
| --- | --- |
| Guarantee | At-least-once. Consumers must be idempotent on `event.id`. |
| Ordering | Best-effort per chat; not guaranteed under retry |
| Backoff | 1s, 2s, 5s, 15s, 60s, 5m, 30m, 2h — 8 attempts |
| Timeout | 10s per attempt |
| Success | Any 2xx |
| Dead letter | After the final attempt; retained 7 days, replayable from the dashboard |
| Circuit breaker | Opens after 20 consecutive failures; half-open probe every 60s |
| Signature | `X-Bunwa-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">` |
| Replay window | Reject signatures older than 5 minutes |

The signature format is timestamp-prefixed deliberately: signing the body alone,
as gowa does, lets an attacker who captures one payload replay it indefinitely.

### SSE

`GET /v1/events/stream` — project-scoped, authenticated, filtered by the same
link rules as webhooks. For dashboards and for development, not a substitute for
webhooks: SSE is best-effort and has no retry.
