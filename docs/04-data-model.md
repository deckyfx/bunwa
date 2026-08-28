# 04 — Data model

*Revised 2026-08-22 for the Project → Environment → Virtual Device model with
system-owned devices.*

Postgres, accessed through Drizzle. This document is the schema's rationale; the
authoritative definition will live in `src/store/schema/`.

## The shape

```
                          ┌──────────────┐
                          │   project    │   Grande
                          └──────┬───────┘
                                 │ 1:N
                          ┌──────▼───────┐
                          │ environment  │   development · staging · production
                          └──────┬───────┘
                     ┌───────────┼────────────┐
                 1:N │       1:1 │        1:N │
            ┌────────▼───┐  ┌────▼─────┐  ┌───▼──────────┐
            │  api_key   │  │ settings │  │virtual_device│
            └────────────┘  │ webhook  │  └───┬──────────┘
                            └──────────┘      │ N:1
                                              │
                                       ┌──────▼───────┐
                                       │    device    │  ← system-owned, global
                                       └──────┬───────┘
                                              │ 1:N
                                       ┌──────▼───────────┐
                                       │ device_consent   │  per project
                                       └──────────────────┘
```

Two changes from the earlier draft, both consequential:

**Devices are system-owned.** There is no `owner` table. A device is a global
system resource identified by its phone number; the human holding that phone is
not a bunwa account, and proves their agency by replying on WhatsApp. This is
simpler and matches reality — you never onboard the phone's owner, you only ever
message them.

**Consent attaches to the project, binding attaches to the environment.** A
customer agrees to "Grande using my number", not to "Grande's staging
environment". So `device_consent` is keyed on `(device, project)`, while
`virtual_device` — the actual routing binding — is per environment. Grande's
dev, staging and prod environments each get their own virtual device, own
webhook and own API key, but the customer is asked exactly once.

Getting that split wrong means asking a customer for permission three times to
onboard one product, which is the friction this whole system exists to remove.

## Tables

### `projects`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `slug` | text unique | `grande` |
| `display_name` | text | **Shown verbatim in the consent message the customer receives** |
| `status` | enum | `active` · `suspended` |
| `created_at` / `updated_at` | timestamptz | |

`display_name` is customer-facing. "Grande would like to send messages from your
number" only works if the name is one they recognise.

### `environments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `project_id` | uuid fk | |
| `slug` | text | `development` · `staging` · `production` |
| `kind` | enum | `live` · `test` — drives key prefixes and quota defaults |
| `status` | enum | `active` · `suspended` |
| `settings` | jsonb | Rate limits, default event filter, retry policy, timezone |
| `created_at` / `updated_at` | timestamptz | |
| unique | `(project_id, slug)` | |

The environment is the unit of configuration. Everything an integrator sets —
webhook URL, secret, filters, quotas — lives here or on the virtual device
beneath it.

### `api_keys`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `environment_id` | uuid fk | **Keys belong to an environment, never a project** |
| `key_hash` | text | Argon2id. Plaintext shown once at creation, never stored. |
| `key_prefix` | text | `bw_live_grande_a1b2…` — first 16 chars, for identification |
| `label` | text | "backend", "cron worker" |
| `scopes` | text[] | |
| `last_used_at` | timestamptz | |
| `expires_at` / `revoked_at` | timestamptz null | |

The key resolves to exactly one environment, and therefore to one project. A
caller never states which project or environment it is — that is derived,
which makes cross-tenant access structurally impossible rather than a check that
could be forgotten.

Key prefixes embed the environment kind and the project slug so a leaked key is
identifiable at a glance and `bw_test_` cannot be mistaken for `bw_live_`.

### `environment_webhooks`

| Column | Type | Notes |
| --- | --- | --- |
| `environment_id` | uuid pk fk | |
| `url` | text | |
| `secret` | text | Encrypted at rest; used for the HMAC signature |
| `enabled` | boolean | |
| `event_filter` | text[] null | Null = all permitted types. `call.offer` excluded by default. |
| `max_attempts` | int | Default 8 |
| `circuit_state` | enum | `closed` · `open` · `half_open` |
| `circuit_opened_at` | timestamptz null | |

A virtual device may override the URL — see below — but the environment webhook
is the default target, which is what most integrations want.

### `devices` — system-owned

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `msisdn` | text unique | E.164. **The system-wide identity of the device.** |
| `jid` | text null unique | WhatsApp JID once paired |
| `push_name` | text null | |
| `engine_kind` | enum | `baileys` · `fake` — was `gowa` · `native` until stage 4 |
| `engine_pool_id` | text | |
| `engine_device_id` | text | The id inside that engine |
| `state` | enum | See the state machine below |
| `state_reason` | text null | |
| `first_paired_at` | timestamptz null | |
| `last_connected_at` / `last_seen_at` | timestamptz null | |
| `created_at` / `updated_at` | timestamptz | |

No `project_id`, no `owner_id`. A device exists once in the system, whichever
project caused it to be paired. `msisdn` being unique is what makes "this phone
is already paired — reuse it?" a primary-key lookup rather than a heuristic.

`engine_kind` + `engine_pool_id` + `engine_device_id` is the indirection that
lets a device move between pools of different kinds with no project
noticing ([11](11-engine-decision.md)).

**State machine:**

```
  unpaired ──startPairing──▶ pairing ──success──▶ connected
      ▲                         │                   │  ▲
      │                      timeout/               │  │reconnect
      │                      failure                ▼  │
      │                         ▼              disconnected
      └──────logout────── logged_out ◀──LoggedOut──┤  │
                               │                      │(backoff exhausted)
                             purge                    ▼
                               ▼                   degraded
                            deleted
```

`logged_out` versus `deleted` mirrors gowa's keep-slot distinction
([01](01-gowa-architecture.md)). A device the customer unlinked keeps its record,
its consents and its virtual devices, so re-pairing restores service without
re-asking anyone for permission.

### `device_consents` — per (device, project)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `device_id` | uuid fk | |
| `project_id` | uuid fk | |
| `status` | enum | `pending` · `granted` · `denied` · `revoked` · `expired` |
| `requested_by_environment_id` | uuid fk | Which environment triggered the ask |
| `challenge_token` | text | Single-use, in the WhatsApp confirmation message |
| `challenge_sent_at` | timestamptz null | |
| `responded_at` | timestamptz null | |
| `response_channel` | enum null | `whatsapp_reply` · `dashboard` · `operator` |
| `evidence` | jsonb | Replying JID, message id, text, IP, user agent |
| `expires_at` | timestamptz | Default +24h |
| unique | `(device_id, project_id)` | One live consent per pair |

Once `granted`, **every environment of that project** may bind a virtual device
to this device without asking again. Revoking here revokes all of them at once.

### `consent_events` — append-only

Never updated, never deleted.

| Column | Type |
| --- | --- |
| `id` | uuid pk |
| `consent_id` | uuid fk |
| `action` | enum: `requested` · `challenge_sent` · `granted` · `denied` · `revoked` · `expired` |
| `actor` | enum: `phone_holder` · `operator` · `system` |
| `channel` | enum |
| `evidence` | jsonb |
| `created_at` | timestamptz |

The question this answers eighteen months later is *"prove this customer agreed"*
— which needs the message id of their reply, not a boolean.

### `virtual_devices` ⭐

The environment's handle onto a physical device. This is the routing unit.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `environment_id` | uuid fk | |
| `device_id` | uuid fk | |
| `alias` | text | Project-chosen name: `otp-sender` |
| `status` | enum | `pending_consent` · `pending_pairing` · `active` · `suspended` · `revoked` |
| `scopes` | text[] | `send:text`, `send:media`, `receive:messages` |
| `jid_allowlist` | text[] null | If set, this binding only ever sees these chats |
| `jid_denylist` | text[] | Wildcards, as gowa |
| `event_filter` | text[] null | Overrides the environment default |
| `webhook_url_override` | text null | Falls back to the environment webhook |
| `quota` | jsonb | Rate limits, daily caps |
| `created_at` / `activated_at` / `revoked_at` | timestamptz | |
| unique | `(environment_id, device_id)` | |

A project addresses `virtual_device.id` or `alias` in the API and never learns
the global `device.id`. Two projects sharing one phone see two unrelated
identifiers, which prevents correlation between tenants and lets a device be
re-pointed later without breaking anyone's integration.

### `deliveries` and `delivery_attempts`

As previously specified, keyed on `virtual_device_id` rather than a link.

| `deliveries` | Type |
| --- | --- |
| `id` | uuid pk |
| `virtual_device_id` | uuid fk |
| `event_id` | uuid |
| `state` | enum: `pending` · `delivered` · `failed` · `dead` |
| `next_attempt_at` | timestamptz |
| `attempt_count` | int |

| `delivery_attempts` | Type |
| --- | --- |
| `id` | uuid pk |
| `delivery_id` | uuid fk |
| `attempted_at` | timestamptz |
| `status_code` | int null |
| `error` | text null |
| `duration_ms` | int |

### `idempotency_keys`

| Column | Type |
| --- | --- |
| `key` | text, client-supplied |
| `environment_id` | uuid fk |
| `request_hash` | text |
| `response` | jsonb |
| `created_at` | timestamptz |
| pk | `(environment_id, key)` |

Scoped to the environment, so a key reused between dev and prod is not a
collision.

### `device_events`

Lifecycle audit, independent of webhook delivery, so history survives a period
when every webhook was failing.

| Column | Type |
| --- | --- |
| `id` | uuid pk |
| `device_id` | uuid fk |
| `type` | text |
| `payload` | jsonb |
| `occurred_at` | timestamptz |

## The onboarding flow, in table terms

Grande's customer enters `+62812…` in Grande's app, which calls bunwa with
Grande's production API key.

```
1. resolve api_key → environment → project
2. SELECT * FROM devices WHERE msisdn = ?

   ├─ not found
   │    INSERT device (state=unpaired)
   │    INSERT device_consent (implicit — this project caused the pairing)
   │    INSERT virtual_device (status=pending_pairing)
   │    → return QR + pairing code, stream progress over SSE
   │
   ├─ found, consent granted to this project
   │    INSERT virtual_device (status=active)
   │    → ready immediately, nothing asked of the customer
   │
   └─ found, no consent from this project
        INSERT device_consent (status=pending, challenge_token)
        SEND WhatsApp challenge to the number, from the device itself
        INSERT virtual_device (status=pending_consent)
        → return { status: "awaiting_confirmation" }
        on reply → consent granted, virtual_device active,
                   `virtualdevice.activated` webhook fired
```

The middle branch is the point of the product: a customer already using Grande
who signs up for a second Grande environment — or who was already paired for a
different reason — gets service with no interaction at all.

The third branch is the cross-project case, and the confirmation arrives on
WhatsApp, from their own number's session, which is about as strong an
authenticity signal as this medium offers.

## Tenant isolation

Three redundant layers, because a single missing predicate is a cross-tenant
leak:

1. **Repository level** — every method takes an `environmentId`; repositories are
   the only route to the database.
2. **Row-level security** — Postgres RLS on `virtual_devices`, `deliveries`,
   `api_keys`, keyed on a session variable.
3. **Fan-out level** — event routing resolves virtual devices *from* the device,
   never the reverse, so an event cannot physically reach an environment without
   an active binding.

## Migrations

Drizzle Kit, forward-only, in `src/store/migrations/`. Expand-migrate-contract,
since engine pools and the control plane deploy independently.
