# 06 — API design

## Principles

1. **Two audiences, two surfaces.** Projects call a machine API with an API key.
   Owners and operators use an admin API with a session. They share nothing but
   the transport.
2. **The device is addressed, the tenant is implied.** A project never passes a
   project id; it is derived from the credential. This makes cross-tenant access
   a structural impossibility rather than a validation rule.
3. **gowa-shaped where it can be.** Send and group payloads stay recognisable so
   existing integrations port with modest effort. This outlived gowa itself:
   the shape is now a compatibility promise to whoever is migrating, not a
   consequence of what sits behind the route.
4. **Versioned from the first commit.** `/v1` prefix. Retrofitting a version is
   never free.

## Authentication

| Surface | Mechanism | Header |
| --- | --- | --- |
| Project API | Environment-scoped API key, Argon2id-hashed at rest | `X-API-Key: bw_live_grande_...` |
| Admin API | Session cookie or bearer token | `Authorization: Bearer ...` |
| Webhook (inbound to you) | HMAC | `X-Bunwa-Signature: t=…,v1=…` |
| Consent callback | Signed, single-use, expiring token | Query parameter |

Keys are prefixed `bw_{live|test}_{project-slug}_…` so they are greppable in
leaked logs, detectable by secret scanners, and impossible to confuse between
environments at a glance. Only the prefix and hash are stored.

## Project API

### Virtual devices, as the project sees them

An environment only ever sees devices it holds an active virtual device for, and
addresses them by the virtual device's id or alias — never by the global device
id. Two projects sharing one phone see two unrelated identifiers.

```
GET    /v1/devices                     this environment's virtual devices
GET    /v1/devices/{ref}               status, state, capability   (ref = id or alias)
POST   /v1/devices/{ref}/reconnect     request reconnection
GET    /v1/devices/{ref}/events        recent lifecycle events (audit)
DELETE /v1/devices/{ref}               unbind this environment only
```

Notably absent: no `logout`, no `purge`. `DELETE` unbinds *this environment's*
virtual device and nothing else — the physical device, its other bindings and
the project's consent all survive. Destroying a device is an admin operation,
because devices are system-owned.

### Claiming a phone number — the core flow

The single call Grande's app makes when a customer enters their number:

```
POST /v1/devices/claim
X-API-Key: bw_live_grande_...

{
  "msisdn": "+628123456789",
  "alias": "otp-sender",
  "pairing_method": "qr",              // or "code"
  "scopes": ["send:text", "send:media", "receive:messages"]
}
```

Three outcomes, driven entirely by what already exists in the system:

| Situation | Status | What the customer experiences |
| --- | --- | --- |
| Number never paired | `201 pending_pairing` — returns `qr` / `pair_code` + SSE URL | Scans once |
| Paired, this project already consented | `201 active` | **Nothing. Ready immediately.** |
| Paired, another project holds it | `202 awaiting_confirmation` | Receives a WhatsApp message asking to confirm reuse |

The middle row is the product. A Grande customer already paired for Grande
production, onboarding to Grande staging, is simply active — because consent is
project-scoped ([04](04-data-model.md)).

The third row is the cross-project case. bunwa sends the challenge to the number
itself; a reply activates the binding and fires `virtualdevice.activated` on the
environment's webhook.

```
GET  /v1/devices/{ref}/pairing/stream   SSE: qr refresh, pair code, progress
POST /v1/devices/{ref}/pairing/refresh  new QR
GET  /v1/devices/{ref}/consent          consent status for this project
```

### Sending

```
POST /v1/devices/{ref}/messages
Idempotency-Key: 9f2c...

{ "to": "+628123456789", "type": "text", "text": "Your code is 448126" }
```

One endpoint, discriminated by `type`. v1 supports exactly six:

| `type` | Payload | gowa endpoint it was mapped to |
| --- | --- | --- |
| `text` | `{ text }` | `/send/message` |
| `image` | `{ media, caption? }` | `/send/image` |
| `document` | `{ media, filename, caption? }` | `/send/file` |
| `link` | `{ url, text?, preview: true }` | `/send/link` |
| `audio` | `{ media, voice_note? }` | `/send/audio` |
| `video` | `{ media, caption? }` | `/send/video` |

The third column is historical: those routes are how the gowa adapter satisfied
each type, and it is kept because it is the clearest statement of what each type
means. Baileys is sent to directly.

`media` accepts a URL, a base64 data URI, or a multipart upload. Adding a type
later is a new union member, not an API change.

**Idempotency is mandatory.** Replaying a key returns the original response byte
for byte; reusing it with a different body is a `409`. For OTP this is the
difference between one code and two.

```
GET    /v1/devices/{ref}/messages/{message_id}        status
GET    /v1/devices/{ref}/messages/{message_id}/media  download inbound media
```

Everything else — reactions, edits, revoke, forward, star, presence, groups — is
deferred with the message types in [02](02-requirements.md). That deferral was
argued partly on gowa already implementing them, so surfacing one was a route
and a mapping. It is not any more — each is now work in the adapter, which
raises the price of every one of them and is a reason to keep the list short
rather than a reason to revisit the deferral.

### Rules

```
GET    /v1/devices/{ref}/rules
POST   /v1/devices/{ref}/rules
PUT    /v1/devices/{ref}/rules/{rule_id}
DELETE /v1/devices/{ref}/rules/{rule_id}
POST   /v1/devices/{ref}/rules/{rule_id}/test     dry run, never sends
```

### Events

```
GET    /v1/events                  paginated history, project-scoped
GET    /v1/events/stream           SSE
GET    /v1/deliveries              delivery log with attempt detail
POST   /v1/deliveries/{id}/replay  re-deliver from the DLQ
```

`/v1/deliveries` is the answer to "did you send it?" — a question every webhook
integration eventually asks in anger.

## Admin API

For owners and operators. Session-authenticated.

```
POST   /admin/v1/projects
POST   /admin/v1/projects/{id}/environments
POST   /admin/v1/environments/{id}/api-keys        plaintext returned once
PUT    /admin/v1/environments/{id}/webhook

GET    /admin/v1/devices                           the global device fleet
GET    /admin/v1/devices/{id}                      state, engine, pool
GET    /admin/v1/devices/{id}/bindings             every project/environment using it
POST   /admin/v1/devices/{id}/logout               keep the record
DELETE /admin/v1/devices/{id}                      purge
POST   /admin/v1/devices/{id}/migrate              move between engine pools

GET    /admin/v1/consents?device_id=…              consent state per project
POST   /admin/v1/consents/{id}/revoke
GET    /admin/v1/consents/{id}/history             immutable audit trail

GET    /admin/v1/engines                           pools, health, device counts
```

`GET /admin/v1/devices/{id}/bindings` is the screen that makes sharing
auditable: *these four projects use this number; here is what each may do;
revoke any of them now.* Because devices are system-owned, this is an operator
view rather than a customer one — the customer's control is the WhatsApp
challenge and the ability to unlink from their phone.

`POST /admin/v1/devices/{id}/migrate` was to be how a device moves from the gowa
engine to the native engine, one device at a time, reversibly — the mechanism
that made stage 4 safe. It was never built, and stage 4 did not need it: no real
device had ever paired, so there was nothing to migrate and the safety came from
`BAILEYS_ENABLED` defaulting to off instead. The route stays specified rather
than deleted, because moving a device between pools is still what the
`engine_kind` / `engine_pool_id` indirection in [04](04-data-model.md) exists
for, and a second engine adapter would need exactly this.

## Errors

RFC 9457 problem details, consistently:

```json
{
  "type": "https://bunwa.dev/errors/awaiting-confirmation",
  "title": "Virtual device is awaiting confirmation",
  "status": 403,
  "detail": "vdev_123 is pending_consent; the phone holder has not yet confirmed reuse for project 'grande'.",
  "instance": "/v1/devices/otp-sender/messages",
  "correlation_id": "01J..."
}
```

Every error carries the correlation id that appears in the logs. Support
conversations become one grep instead of a timestamp hunt.

| Status | Used for |
| --- | --- |
| 400 | Malformed request |
| 401 | Missing or invalid credential |
| 403 | Valid credential, insufficient scope, or virtual device not active |
| 404 | Not found, **or** not visible to this tenant — deliberately indistinguishable |
| 409 | Idempotency conflict, state conflict |
| 422 | Semantically invalid (bad JID, unsupported media type) |
| 429 | Quota or rate limit; `Retry-After` always set |
| 503 | Device not connected; `Retry-After` when reconnection is expected |

404-for-forbidden on cross-tenant reads is intentional: distinguishing "does not
exist" from "exists but is not yours" leaks the existence of other tenants' data.

## OpenAPI

Generated from TypeBox schemas by Elysia, published at `/openapi.json`, and
diffed in CI so that a breaking change to a shipped endpoint fails the build
rather than a customer's integration.
