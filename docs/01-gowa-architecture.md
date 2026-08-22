# 01 — How gowa works

*Stage 1 study notes. gowa `main` @ `0427b9f`, Go 1.26, Fiber v3, whatsmeow
pinned 2026-08-21. Source lives read-only in [`reference/gowa`](../reference/gowa).*

Read this before writing any bunwa code. Most of gowa's design decisions are
correct and should be copied; the goal here is to know precisely which ones are
not, and why.

## Shape and size

51,150 lines of Go across a clean, conventional layered architecture:

```
src/
├── cmd/            1.5k   cobra entry points — `rest` and `mcp` subcommands
├── config/         0.2k   package-level mutable globals (see "Config" below)
├── domains/        1.2k   interfaces + request/response structs only, no logic
├── infrastructure/  27k   the real work
│   ├── whatsapp/    12.8k   whatsmeow wiring, device manager, event handlers
│   ├── chatwoot/     6.4k   Chatwoot helpdesk integration
│   ├── chatstorage/  3.9k   SQLite chat/message persistence
│   └── uiasset/      0.6k   downloads the dashboard HTML from a GitHub release
├── pkg/            4.7k   utils, sqlite helpers, error types
├── ui/             6.9k   rest/ (Fiber handlers), mcp/ (MCP server), websocket/
├── usecase/        5.6k   orchestration between ui and infrastructure
└── validations/    4.1k   request validation, one file per domain
```

**Observation worth internalising:** a quarter of the codebase
(chatwoot + chatstorage ≈ 10k lines) is features bunwa explicitly does not want.
The "51k lines to port" figure that makes a rewrite look terrifying is closer to
30k once you drop what you don't need — still a lot, but the number should be
honest in both directions.

## Layering and request flow

```
HTTP request
   │
   ▼  src/ui/rest/*.go          Fiber handler: bind + validate DTO
   ▼  src/validations/*.go      field rules
   ▼  src/usecase/*.go          orchestration, resolves which device to use
   ▼  src/infrastructure/whatsapp/   DeviceManager → DeviceInstance → whatsmeow client
   ▼  whatsmeow                 WhatsApp socket
```

The separation is disciplined and bunwa should mirror it. `domains/` holding
only interfaces and DTOs — no behaviour — is a pattern worth keeping.

## Device management

`DeviceManager` ([961 lines](../reference/gowa/src/infrastructure/whatsapp/device_manager.go))
is the most instructive file in the repository. It owns a map of
`DeviceInstance`, each wrapping one whatsmeow client, and implements a set of
lifecycle operations that took real production pain to arrive at:

| Method | Why it exists |
| --- | --- |
| `CreateDevice` / `EnsureClient` | Lazily materialise a whatsmeow client for a slot |
| `LogoutDeviceKeepSlot` | Log out **without** destroying the slot id, display name, or chat history |
| `PurgeDevice` | The destructive variant — deletes store rows for the JID |
| `companionClaimedByOther` | Guards against two slots claiming the same companion device |
| `LoadExistingDevices` | Rehydrate everything from the registry on boot |
| `ResolveDevice` | Fall back to a default device when the caller omits `device_id` |

**Keep-slot logout is the subtle one.** When a user unlinks from their phone,
gowa deliberately preserves the slot and the chat history, clearing only the
persisted JID and in-memory client. Any device abstraction bunwa builds must
reproduce this distinction — "logged out but still provisioned" is a genuinely
different state from "deleted", and conflating them loses customer data.

Storage defaults to SQLite (`file:storages/whatsapp.db`), with an optional
separate keys database (`DBKeysURI`).

## Event handling

One switch in
[`event_handler.go`](../reference/gowa/src/infrastructure/whatsapp/event_handler.go)
dispatches 24 whatsmeow event types. Message-shaped events get normalised and
forwarded; lifecycle events do not.

**Events forwarded to webhooks — 17, all message-shaped:**

`message` · `message.reaction` · `message.revoked` · `message.edited` ·
`message.ack` · `message.deleted` · `chat_presence` · `group.participants` ·
`group.joined` · `label.edit` · `label.association` · `newsletter.joined` ·
`newsletter.left` · `newsletter.message` · `newsletter.mute` · `call.offer`

**Events that stay inside the process:**

| whatsmeow event | What gowa does | Consequence |
| --- | --- | --- |
| `LoggedOut` | Internal WS broadcast `DEVICE_LOGGED_OUT`, log line | Backend never learns the device died |
| `Connected` | Updates internal state | No recovery notification |
| `StreamReplaced` | **`os.Exit(0)`** | Kills every other device in the process |
| `PairSuccess`, `PairPasskey*` | WS broadcast only | Pairing progress invisible to API consumers |
| `UndecryptableMessage` | `log.Warnf` and drop | Silent message loss, by design and documented as such |

The internal WebSocket at `/ws` broadcasts six codes — verified by grepping
actual `websocket.Broadcast <-` sites, and by observation
([12](12-stage0-findings.md)): `DEVICE_LOGGED_OUT`, `LOGIN_SUCCESS`,
`PASSKEY_REQUEST`, `PASSKEY_CONFIRMATION`, `PASSKEY_ERROR`, and the two
config echoes `DEVICE_WEBHOOK_UPDATED` / `DEVICE_WEBHOOK_CONFIG_UPDATED`.

There is **no** `QRDATA` broadcast; QR data is returned in the body of
`GET /devices/{id}/login`. An earlier draft of this document claimed otherwise.

**`DEVICE_LOGGED_OUT` is the hook bunwa exploits.** The single most important
lifecycle signal does exist; it simply never leaves the browser channel, and an
adapter that speaks `/ws` can recover it without patching gowa. Everything else
— QR, connect, disconnect, degraded — must come from polling
`/devices/{id}/status`, which is the reconciler's actual source of truth. Both
halves are specified in [05](05-events-and-rules.md); the measured detail is in
[12](12-stage0-findings.md).

## Webhook delivery

[`webhook_forward.go`](../reference/gowa/src/infrastructure/whatsapp/webhook_forward.go)
(1,472 lines) is more sophisticated than expected and is worth studying closely:

- Per-device webhook config with fallback to the global `WhatsappWebhook` list
- Event whitelisting, per device
- JID ignore lists, with `@g.us` / `@s.whatsapp.net` / `@lid` wildcards
- HMAC signature over the payload (`WhatsappWebhookSecret`)
- Partial-failure tolerance: only errors when *every* target fails
- Payload enrichment with the operator-facing session id, done synchronously
  before goroutines fan out — a deliberate data-race avoidance

What it lacks: **retries, backoff, and a dead-letter queue.** A webhook target
that is down for thirty seconds loses those events permanently. For a proxy
other businesses depend on, durable delivery is not optional — see
[ADR-0004](adr/0004-durable-delivery.md).

## Automation

[`auto_reply.go`](../reference/gowa/src/infrastructure/whatsapp/auto_reply.go),
112 lines, gated on one global string. It is careful about *when* to reply
(skips groups, broadcasts, `status@`, self-messages, non-typed text) and that
guard logic is worth porting almost verbatim into bunwa's rule engine as a
default safety predicate. But it supports exactly one static response for every
device and every sender.

## Configuration

`src/config/settings.go` — package-level mutable globals set from CLI flags and
environment variables. Idiomatic for a single-tenant Go binary, and completely
unsuitable for a multi-tenant control plane, where nearly everything gowa treats
as global (webhook targets, auth credentials, auto-reply, event whitelists)
becomes per-link state in a database.

## The API surface

82 paths in [`docs/openapi.yaml`](../reference/gowa/docs/openapi.yaml), grouped:

| Group | Count | Notes |
| --- | --- | --- |
| `/send/*` | 12 | message, image, audio, file, sticker, video, contact, link, location, poll, presence, chat-presence |
| `/message/{id}/*` | 10 | revoke, delete, reaction, update, read, star, unstar, forward, download |
| `/group/*` | 20 | full group administration |
| `/user/*` | 9 | info, avatar, pushname, privacy, groups, newsletters, contacts, check, business-profile |
| `/devices/*` | 7 | CRUD, login, login/code, logout, reconnect, status, webhook |
| `/app/*` | 9 | legacy single-device equivalents |
| `/chat/*`, `/chats` | 5 | chat storage and history |
| `/newsletter/*` | 2 | |
| `/chatwoot/*` | 6 | out of scope for bunwa |
| `/health` | 1 | |

`/app/*` is the pre-multi-device legacy surface, superseded by `/devices/*`.
bunwa should implement `/devices/*` semantics only and not carry the legacy
duplication forward.

## What to copy, what to discard

| Copy | Discard |
| --- | --- |
| Layered `ui → usecase → infrastructure` separation | Global mutable config |
| Keep-slot vs purge logout distinction | `os.Exit(0)` on `StreamReplaced` |
| Per-device webhook config, event whitelist, JID ignore lists | Global webhook fallback |
| HMAC-signed webhook payloads | Fire-and-forget delivery with no retry |
| Auto-reply's "should we respond at all" guard predicates | Single-static-string auto-reply |
| The OpenAPI-first discipline | `/app/*` legacy endpoints |
| Presence pulse and rate-limit awareness | Chatwoot integration (6.4k lines) |
| — | Chat storage / history sync (3.9k lines) — see [02](02-requirements.md) |

## Open questions to resolve during stage 1

1. How does gowa behave when two slots race to claim the same phone number?
   `companionClaimedByOther` suggests this is handled — verify empirically,
   because bunwa's device-sharing model makes it a routine occurrence rather
   than an edge case.
2. What is the real memory and file-descriptor cost per connected device? This
   sets the density ceiling and therefore the deployment topology.
3. How long does whatsmeow take to notice a silently dropped socket? That
   latency is the floor on how fast bunwa can emit `device.disconnected`.
4. Does `POST /devices/{id}/webhook` accept multiple URLs, or replace? Affects
   whether the gowa adapter can register bunwa as one target among several.

Progress against these is tracked in [12 — Stage 0 findings](12-stage0-findings.md).
