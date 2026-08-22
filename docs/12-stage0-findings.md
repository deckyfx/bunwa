# 12 — Stage 0 findings

*Stage 0 complete except for the two-device memory check. Measurements from the harness in
[`deploy/stage0/`](../deploy/stage0/README.md), against
`ghcr.io/aldinokemal/go-whatsapp-web-multidevice:latest` (gowa UI v1.6.0),
unmodified. Started 2026-08-22.*

Everything here replaces an assumption made earlier in the design docs.

> **A note on the samples below.** Phone numbers, LIDs, message ids and call ids
> are redacted. The LID in particular is a persistent WhatsApp identifier for a
> real person who was not party to this project — the same class of third-party
> data the address-book finding below argues bunwa must strip. An earlier
> revision of this document committed them verbatim; the history was rewritten
> before the repository gained a remote.
 Where a
finding contradicts an earlier document, the earlier document has been corrected
and this one is the record of why.

## ⚠️ Correction: `/ws` carries far less than I claimed

Earlier documents ([01](01-gowa-architecture.md), [05](05-events-and-rules.md),
[10](10-single-container.md)) listed seven broadcast codes on gowa's `/ws`,
including `QRDATA` and `LIST_DEVICES`. **That was wrong.** I had grepped for
string literals in `Code:` positions and conflated REST response codes with
WebSocket broadcasts.

Grepping for actual `websocket.Broadcast <-` sites gives the true list — six
codes, from five call sites:

| Code | Emitted from | Useful for lifecycle? |
| --- | --- | --- |
| `DEVICE_LOGGED_OUT` | `event_handler.go:238` (remote), `usecase/app.go:283`, `usecase/device.go:141` (API) | ✅ **Yes — the one that matters** |
| `LOGIN_SUCCESS` | `event_handler.go:169` (`PairSuccess`) | ✅ Yes |
| `PASSKEY_REQUEST` / `PASSKEY_CONFIRMATION` / `PASSKEY_ERROR` | `event_handler.go:179–209` | Only for passkey pairing |
| `DEVICE_WEBHOOK_UPDATED` / `DEVICE_WEBHOOK_CONFIG_UPDATED` | `usecase/device.go:222–283` | ❌ Config echo, not lifecycle |

**There is no `QRDATA` broadcast anywhere in the source.** QR data is returned
synchronously in the body of `GET /devices/{id}/login`, as a PNG URL:

```json
{"code":"SUCCESS","results":{"device_id":"stage0-a","qr_duration":30,
 "qr_link":"http://…/statics/qrcode/scan-qr-cbd622ff….png"}}
```

Verified empirically: with the tap connected across a full QR request and its
30-second refresh window, `ws.jsonl` stayed empty.

**What this changes.** `/ws` is worth exactly two signals: `DEVICE_LOGGED_OUT`
and `LOGIN_SUCCESS`. Everything else the reconciler needs — QR, connect,
disconnect, degraded — must come from polling. This does not break the design;
it sharpens it. The poller was already specified as the source of truth
([05](05-events-and-rules.md)), and `/ws` is now clearly a latency optimisation
on the single most important event rather than a broad event source.

It also means bunwa's `device.qr` event is synthesised by the adapter from the
login response, not bridged.

## ⚠️ `/devices` and `/devices/{id}/status` disagree

A device slot created but never paired:

```
GET /devices              → {"id":"stage0-a","state":"connected", …}
GET /devices/stage0-a/status → {"is_connected":false,"is_logged_in":false}
```

The list endpoint reported `connected` for a device that had never been paired
and whose socket was down. `state` in the list appears to track something other
than usable connectivity, and must not be trusted.

**The reconciler polls `/devices/{id}/status` and keys on the pair
`(is_connected, is_logged_in)`.** Two booleans, not one string:

| `is_connected` | `is_logged_in` | bunwa state |
| --- | --- | --- |
| false | false | `unpaired` or `disconnected` — disambiguated by whether a JID was ever recorded |
| true | false | `pairing` — socket up, not authenticated |
| true | true | `connected` — the only state in which sends may be attempted |
| false | true | `disconnected` — credentials intact, socket lost. **Reconnect.** |

This is a better state signal than the single `state` string would have been, so
the correction improves the design.

## `/ws` requires a device to exist

The upgrade is rejected before any device slot exists:

```
GET /ws → 400 {"code":"DEVICE_ID_REQUIRED",
  "message":"device_id is required via X-Device-Id header or device_id query"}
```

gowa's `DeviceMiddleware` gates every route including `/ws`. Once at least one
device exists, `ResolveDevice("")` falls back to the default, so a bare `/ws`
connects — but passing `?device_id=<id>` explicitly is correct and robust.

The gate is admission only: the broadcast hub keeps a single global `Clients`
map and `broadcastMessage` writes to all of them, so **one connection receives
every device's broadcasts**. The many-devices-one-tap assumption holds.

**Consequence for the adapter:** at cold start with zero devices there is no
`/ws` at all. The poller must be the bootstrap path, and the `/ws` client must
attach lazily and tolerate being unavailable. Reinforces the same conclusion as
the finding above.

## Resource baseline

| Devices | Memory | FDs | PIDs |
| --- | --- | --- | --- |
| 0 (idle, dashboard loaded) | **19.0 – 19.9 MiB** | 44–46 | 17 |

Notably small. The fixed cost of a gowa process is negligible against a
container budget, which is good news for the colocated single-container topology
([ADR-0007](adr/0007-gowa-engine-for-v1.md)) and suggests per-device cost, not
process overhead, will set the density ceiling.

Marginal cost per connected device: **pending a paired device.**

## Send: all six v1 types work

Measured 2026-08-22, self-send to the paired number, fixtures generated locally
and served in-process (`bun run stage0:send`). Latency is gowa-side only —
request accepted to response returned.

| Type | Endpoint | Latency | Result |
| --- | --- | --- | --- |
| text | `POST /send/message` (JSON) | **639 ms** | ✅ |
| link + preview | `POST /send/link` (JSON) | 2,025 ms | ✅ (after one retry — see below) |
| image | `POST /send/image` (multipart, `image_url`) | 1,519 ms | ✅ |
| PDF | `POST /send/file` (multipart, `file_url`) | 629 ms | ✅ |
| audio | `POST /send/audio` (multipart, `audio_url`) | 772 ms | ✅ |
| video | `POST /send/video` (multipart, `video_url`) | 1,252 ms | ✅ |

**The OTP path is 639 ms** against a target of p95 < 2 s ([02](02-requirements.md)
N8), with bunwa's own overhead still to be added. Comfortable.

All four media endpoints accept either a binary part or a `*_url` field. The URL
form is what the adapter should prefer: it avoids buffering the payload twice.

### ⚠️ `/send/link` performs a server-side fetch — SSRF surface

The link send failed on first attempt with:

```
500 INTERNAL_SERVER_ERROR  Get "https://bun.sh": dial tcp: lookup bun.sh: Try again
```

gowa fetches the target URL **server-side** to build the preview. Two
consequences, both real:

1. **SSRF.** A project supplying `link` causes the engine to fetch an arbitrary
   URL from inside your network. `http://169.254.169.254/` and friends. bunwa
   must validate link targets before forwarding — scheme allowlist, private
   range block, resolve-then-pin. This was flagged as a stage 2 concern in
   [08](08-roadmap.md); it is now confirmed as a stage 1 requirement, because
   the engine does the fetching whether bunwa likes it or not.
2. **No retry.** One transient DNS failure became a hard 500 to the caller. The
   same call succeeded 40 seconds later, unchanged. bunwa must retry link sends,
   or build previews itself.

### ⚠️ Self-sent messages produce no inbound event

Sending to your own number via the API generated **zero webhooks** — no
`message`, no `message.ack` — and no message event in gowa's logs. whatsmeow
does not echo back messages the API itself sent.

The sink was verified reachable and working during the same window (a manual
probe from inside the container arrived and was logged, correctly flagged
`SIG BAD` for being unsigned), so this is gowa's behaviour, not a harness fault.

**Consequence for testing:** self-send exercises the send path only. Testing
inbound needs either a message sent *from the paired phone itself* (which the
companion session does observe, with `is_from_me: true`) or a message from a
different number (`is_from_me: false`). Both cases must be tested — bunwa's
normaliser has to handle the distinction, and a rule engine that replies to
`is_from_me: true` events would loop.

## Inbound: the payload shape, and three things it gives away

First genuine inbound message captured 2026-08-22 — an image with a caption,
from a number other than the paired device. **HMAC signature verified**, so
`X-Hub-Signature-256: sha256=<hex>` over the raw body is confirmed working
against real traffic and not just against the source.

```jsonc
{
  "device_id":  "628xxxxxxxxxx@s.whatsapp.net",   // the paired device's JID
  "session_id": "stage0-a",                       // OUR slot id
  "event": "message",
  "payload": {
    "id":        "<message-id>",
    "timestamp": "2026-08-22T10:28:03Z",
    "from":      "628xxxxxxxxxx@s.whatsapp.net",
    "from_lid":  "<caller-lid>@lid",
    "chat_id":   "628xxxxxxxxxx@s.whatsapp.net",
    "chat_lid":  "<caller-lid>@lid",
    "from_name":            "<sender's own WhatsApp push name>",
    "sender_display_name":  "<what the DEVICE OWNER saved them as>",
    "is_from_me": false,
    "body": "Test...",                            // caption, duplicated
    "image": {
      "caption": "Test...",
      "path": "statics/media/1787394484-6cdd….jpeg"   // container filesystem path
    }
  }
}
```

### `session_id` is the join key, not `device_id`

`device_id` carries the WhatsApp JID; `session_id` carries the slot id bunwa
created. The adapter must key on `session_id` — it is the only field that maps
back to a `devices` row before the JID is known, and it survives a re-pair.

### Inbound media is a file path, not a URL or a blob

`image.path` is a path **inside the gowa container**, not a URL and not base64.
`WHATSAPP_AUTO_DOWNLOAD_MEDIA=true` makes gowa write every inbound media file to
`/app/statics/media/`. Verified two ways to reach it:

| Route | Works | Notes |
| --- | --- | --- |
| Shared volume — read the file directly | ✅ Present on the host at `data/statics/media/`, 50,116 bytes | Only possible when colocated or on shared storage |
| `GET /statics/media/<name>` | ✅ `200 image/jpeg` | Works in any topology |

**Two consequences.**

*Topology:* the HTTP route works everywhere, so the adapter should use it and
never depend on a shared volume. That keeps the split-container option open
([03](03-architecture.md)).

*Isolation:* `/statics/media/<name>` is a **flat, unauthenticated namespace
covering every device**. Any caller who can reach gowa can fetch any device's
media by filename. Inside bunwa's topology gowa is unreachable from outside, so
this is contained — but it means bunwa must never proxy that path through to a
project. Media must be fetched by bunwa, re-served under a virtual-device-scoped
URL, and authorised per request.

*Operations:* gowa writes every inbound media file to disk with no retention
policy. Unbounded growth. bunwa needs a reaper, or `WHATSAPP_AUTO_DOWNLOAD_MEDIA=false`
plus on-demand download.

### ⚠️ The payload leaks the device owner's address book

Two different names arrive:

| Field | Source | Multi-tenant implication |
| --- | --- | --- |
| `from_name` | The sender's own WhatsApp push name | Fine — the sender chose to publish it |
| `sender_display_name` | **What the device owner saved this contact as** | Leaks the owner's private contact naming |

In the captured payload these differed: the push name was the sender's full
name, while `sender_display_name` was the informal name the device owner had
saved them under.

That second field is the phone holder's private data, not the sender's, and
gowa forwards it to every webhook. In a shared-device system, project A learning
how the customer names their contacts is a real privacy problem — and it is
exactly the kind of thing a consent screen never mentions.

**Decision:** bunwa strips `sender_display_name` by default and gates it behind
an explicit `receive:contact_names` scope on the virtual device
([04](04-data-model.md)). Add it to the consent copy if a project ever requests it.

### `is_from_me` both ways, same shape

A message sent from the paired phone itself arrives with `is_from_me: true` and
an **otherwise identical structure** — same fields, same nesting, no marker
beyond the boolean. `sender_display_name` is populated for own messages too (it
equals the owner's own name).

That single boolean is therefore the only thing standing between a reply rule
and an infinite loop, which is why [05](05-events-and-rules.md) excludes
bunwa-originated events by default and caps chain depth. Note it is *not*
sufficient on its own: a message the owner sends from their phone is
`is_from_me: true` but is **not** bunwa-originated, so `meta.origin` and
`is_from_me` are two different signals and both are needed.

### LID identifiers appear alongside phone JIDs

Both `from`/`chat_id` (phone JID) and `from_lid`/`chat_lid` (`@lid`) are present.
WhatsApp is migrating toward LIDs as privacy-preserving identifiers, so the
normaliser must carry both and bunwa's own schema should treat the LID as the
stable key, with the phone JID as a possibly-absent convenience. Designing
around the phone JID alone will age badly.

## ⚠️ The media payload is polymorphic — an object *or* a bare string

The captured image arrived as an object because it had a caption. Reading
`buildAutoDownloadPayload` in `event_message.go:527` shows that is conditional:

```go
func buildAutoDownloadPayload(extracted utils.ExtractedMedia) any {
    if extracted.Caption != "" {
        return map[string]any{"path": ..., "caption": ...}   // object
    }
    return extracted.MediaPath                                // bare string
}
```

So `payload.image` is `{path, caption}` **when captioned** and `"statics/media/…"`
**when not**. Same for `document` and `video`. And `audio` never goes through
that helper at all — with auto-download on it is *always* a bare string
(`event_message.go:352`).

A normaliser written from the one captured example — `payload.image.path` —
crashes on the first uncaptioned image. This is worth stating plainly because
the shape looked stable and was not: **the observed sample was the exceptional
branch, not the common one.** Every media field must be parsed as
`string | {path, caption}` before anything else touches it.

### The shape also flips entirely on a config flag

| `WHATSAPP_AUTO_DOWNLOAD_MEDIA` | `payload.image` |
| --- | --- |
| `true` (default) | `{path, caption}` or `"statics/media/…"` — a local file |
| `false` | `{url, caption}` — WhatsApp's **encrypted CDN URL**, useless without the media keys |

The adapter must pin this flag and treat it as part of the engine contract, not
as an operator preference.

### ⚠️ Documents lose their filename when auto-download is on

| Mode | `payload.document` |
| --- | --- |
| auto-download **on** | `{path, caption}` or bare string — **no `filename`** |
| auto-download **off** | `{url, filename}` — **no local file** |

You cannot get the file *and* its original filename from the same webhook. For
the PDF requirement ([02](02-requirements.md) F4.3) the filename is not
optional — "invoice-2026-08.pdf" versus "1787394484-6cdd….pdf" is the whole
point.

**Open:** whether `GET /message/{id}/download` returns the original filename, or
whether it must be read from gowa's chat storage. Resolve before building the
document path.

## Q7 answered: `PATCH`, replaces, and it is not really a PATCH

The route is **`PATCH /devices/{id}/webhook`** — not `POST`, not `PUT`, both of
which return `405 Method Not Allowed`.

**It is not documented in `openapi.yaml`**, which lists only `GET` for that path.
The setter exists in `ui/rest/device.go:31` and works. So the spec has drifted
from the code, which matters because [01](01-gowa-architecture.md) proposed using
`openapi.yaml` as the port checklist — it is a floor, not a complete inventory.

Behaviour, measured:

| Question | Answer |
| --- | --- |
| Append or replace? | **Replace.** Setting `hook-b` after `hook-a` leaves only `hook-b`. |
| Multiple targets? | Yes — one comma-separated string: `"http://a/hook,http://b/hook"` |
| Empty string? | Clears it; the device falls back to the global `WHATSAPP_WEBHOOK` |

**The footgun:** despite the verb, omitted fields are *cleared*, not preserved.
Sending `{"webhook_url": "…"}` without `webhook_secret` wiped a
previously-configured secret to `""` — silently, with a `SUCCESS` response, and
subsequent webhooks would be signed with an empty key. It behaves as `PUT`.

**Consequence:** the adapter must always send the complete webhook object,
read-modify-write, never a partial update. Worth a comment at the call site,
because the verb actively misleads.

## ✅ F4b confirmed: gowa observes calls and does nothing

An incoming call to the paired number, left to ring out:

```jsonc
{
  "device_id": "628xxx@s.whatsapp.net",
  "session_id": "stage0-a",
  "event": "call.offer",
  "timestamp": "2026-08-22T10:43:26Z",          // note: top level here
  "payload": {
    "call_id": "<call-id>",
    "auto_rejected": false,                      // ← the requirement
    "from": "628xxx@s.whatsapp.net",
    "from_lid": "<caller-lid>@lid",
    "sender_display_name": "<owner's contact name for the caller>",
    "remote_platform": "android",
    "remote_version": "2.26.31.77"
  }
}
```

gowa logged `Incoming call from …`, forwarded the webhook, and **attempted no
rejection** — zero reject-related log lines across the whole session. The call
rang the phone normally. Requirement F4b ([02](02-requirements.md)) is satisfied
by configuration alone, with `WHATSAPP_AUTO_REJECT_CALL` left at its default.

Three details worth carrying forward:

**The envelope is inconsistent between event types.** `timestamp` sits at the
top level on `call.offer` but inside `payload` on `message`. The normaliser must
not assume a uniform envelope; read defensively from both positions.

**The address-book leak is not limited to messages.** `sender_display_name`
appears on call events too, so the stripping decision above must be applied at
the envelope level, not per event type.

**Caller device fingerprinting.** `remote_platform` and `remote_version` expose
the caller's WhatsApp build. Harmless in isolation, but it is third-party data
about someone who never consented to anything, forwarded to a tenant. Strip it
with `sender_display_name` unless a project has a stated need.

## 🚨 Socket-drop detection takes 203 seconds

Measured with a 90-second network cut, polling `/devices/{id}/status` from
inside the container via `docker exec` (the published port is unreachable during
the cut; the daemon channel is not).

| | Measured |
| --- | --- |
| **Detection** — network cut → `is_connected` flips false | **202.9 s** (3 m 23 s) |
| **Recovery** — network restored → `is_connected` true again | **2.1 s** |
| Manual reconnect needed? | No — recovers by itself |

Recovery is excellent. Detection is the problem.

**gowa logs nothing at all when the socket dies.** Not a warning, not an error —
the log is silent across the entire outage. An earlier version of this probe
watched the logs for a disconnect line and hung waiting for one that never came.
Log scraping is not a viable detection channel.

### Why 203 seconds is a product problem, not a tuning detail

For **203 seconds after a device silently loses its connection, gowa reports
`is_connected: true`.** In that window it will accept sends for a device that
cannot deliver them. For OTP — the primary use case — that is a black hole:
the API returns success, the code never arrives, the user never logs in, and
nothing anywhere reports an error.

The cut in this test was abrupt (the container removed from its network), which
is the realistic case: a NAT timeout, a dropped mobile link, a cloud network
blip. There is no TCP FIN, so the socket stays open until a keepalive gives up.

### Consequences for the design

**1. `is_connected` is a lagging indicator and must not gate sends alone.**
[05](05-events-and-rules.md) treats the status poll as the source of truth for
device state. It still is — but its worst-case staleness is now measured at
~3.4 minutes, not the one poll interval assumed. `device.disconnected` inherits
that floor.

**2. Delivery must be confirmed by ack, not by send acceptance.** A successful
`POST /send/message` means gowa queued it, nothing more. bunwa must track
`message.ack` per outbound message and raise `message.undelivered` when no ack
arrives inside a timeout. For OTP that timeout should be seconds, and it should
be the signal that triggers a retry or a fallback channel — not a support ticket
three days later.

**3. bunwa needs an independent liveness probe.** Options, cheapest first:

| Approach | Cost | Detection |
| --- | --- | --- |
| Trust `is_connected` | free | ~203 s |
| Watch for ack silence on a live send | free | seconds, but only when sending |
| Periodic presence write, watch for failure | one call/device/interval | ~interval |
| Both, combined | — | **recommended** |

gowa already runs a five-minute presence pulse and logs when it fails
(`[PRESENCE_PULSE] failed to mark device …`). That failure is a stronger
liveness signal than `is_connected`, and it is a log line rather than an API —
worth checking whether it can be triggered on demand through
`POST /send/presence`, which would give bunwa an active probe at any interval it
chooses.

**4. This is engine-agnostic.** A native Baileys engine faces the same physics —
a silently dropped TCP socket is invisible until a keepalive expires. The
difference is that with Baileys the keepalive interval is ours to configure,
whereas through gowa it is whatever whatsmeow chose. That is a genuine point in
favour of engine #2 ([11](11-engine-decision.md)) and should be added to its
entry criteria.

## 🚨 PROVEN: a remote logout reaches no webhook

The finding this whole project rests on, demonstrated end to end rather than
inferred from source. Device unlinked from the phone at **10:55:14**:

| Channel | Result |
| --- | --- |
| gowa log | `[REMOTE_LOGOUT] Received LoggedOut event for device stage0-a - user logged out from phone` |
| `/ws` broadcast | `DEVICE_LOGGED_OUT {"device_id":"stage0-a"}` at 10:55:14.906 — **instant** |
| **Webhook sink** | **Nothing. Zero.** Webhook count unchanged at 4 across the event. |
| gowa's own forward counter | 3 forwards all session — 2 × `message`, 1 × `call.offer`. **No lifecycle forward was ever attempted.** |

An integrator whose only channel is the webhook — which is the only channel gowa
documents — **never learns the device is gone.** They find out when a send fails,
or when a customer complains that no OTP arrived.

### The state transition, confirmed

| | Before | After |
| --- | --- | --- |
| `is_connected` | true | **false** |
| `is_logged_in` | true | **false** |
| slot `id` | `stage0-a` | `stage0-a` — **survives** |
| `display_name` | present | **preserved** |
| `jid` | `628xxx@s.whatsapp.net` | **cleared** |
| list `state` | `logged_in` | `disconnected` |

Keep-slot logout behaves exactly as `LogoutDeviceKeepSlot` documents: the slot
and display name survive, the JID is cleared. This validates the `logged_out`
versus `deleted` distinction in [04](04-data-model.md) — re-pairing restores
service without re-asking anyone for consent, because the row and its bindings
are still there.

Note `state` reports `disconnected`, not a distinct logged-out value, so the
list endpoint cannot distinguish "socket lost, credentials intact" from "logged
out entirely". Only the `(is_connected, is_logged_in)` pair can:
`(false, true)` is a recoverable drop; `(false, false)` with a previously-known
JID is a logout requiring a re-pair. The reconciler must carry the last known
JID to tell them apart.

### The synthesis bunwa performs

```
gowa /ws  DEVICE_LOGGED_OUT ──┐
                              ├──▶ reconciler ──▶ bunwa `device.logged_out`
poll (false, false) + known JID ┘                   ├─▶ every bound environment's
                                                    │   webhook, signed and retried
                                                    └─▶ SSE, dashboard, audit log
```

`/ws` gives it instantly; the poll catches it within one interval if `/ws` is
unavailable. Either way the event leaves the system — which is the entire
difference between gowa and bunwa for this case.

### Also observed: reconnect backoff during the outage

```
[Client-stage0-a ERROR] Error reconnecting after autoreconnect sleep:
  failed to dial whatsapp web websocket: failed to WebSocket dial …
```

whatsmeow *does* log its reconnect attempts — it simply logs nothing when the
socket first dies. So the log is useful for observing recovery attempts and
useless for detecting the initial failure, consistent with the 203-second
finding above.

## gowa uses panic-as-control-flow

Recurring in the logs:

```
level=error msg="Panic recovered in middleware: Error timeout get avatar!"
level=error msg="Panic recovered in middleware: Get \"https://bun.sh\": ... Try again"
level=error msg="Panic recovered in middleware: your session have been saved, ..."
```

Error paths panic and are caught by the recovery middleware, surfacing as
`500 INTERNAL_SERVER_ERROR` with the message in the body. There is no error
taxonomy to map — the adapter gets one status code and a human-readable string.

**Consequence:** the gowa adapter must classify failures by matching the message
text, which is brittle, and must default to *retryable* rather than *fatal* when
it cannot classify. Worth building a known-message table early and treating
anything unmatched as transient.

## Presence pulse cycles the device

```
10:14:02  [PRESENCE_PULSE] failed to mark device as available: can't send presence without PushName set
10:15:02  [PRESENCE_PULSE] marked device stage0-a as available
10:20:02  [PRESENCE_PULSE] marked device stage0-a as unavailable
```

gowa toggles presence on a five-minute cycle, and the first attempt after
pairing fails because `PushName` is not yet populated — a startup race that
resolves on the next tick. Harmless, but the reconciler must not read a presence
failure as a connectivity problem.

## Memory: one connected device costs ~55 MiB

| State | Memory | FDs | PIDs |
| --- | --- | --- | --- |
| 0 devices, idle | 15 MiB | 51 | 17 |
| 1 device, paired and connected | **70 MiB** | 55 | 22 |

A **~55 MiB marginal cost per connected device**, and +5 PIDs. Extrapolating
naively, a 4 GB container holds roughly 70 devices.

That figure needs a second device to confirm it is marginal rather than a
one-off allocation, but if it holds it sets two things: the engine pool size in
[03](03-architecture.md), and the fact that the colocated single-container
topology ([ADR-0007](adr/0007-gowa-engine-for-v1.md)) is a small-deployment
answer, not a scaling one.

## Confirmed as designed

| Claim | Status |
| --- | --- |
| Webhook signature is `X-Hub-Signature-256: sha256=<hex hmac-sha256(body, secret)>` | ✅ Verified in `webhook.go:65` and by the sink |
| `WHATSAPP_AUTO_REJECT_CALL` defaults false; gowa does not reject calls unless asked | ✅ Verified in `event_call.go:19` |
| `POST /devices` creates a slot with a caller-chosen id, and accepts per-device webhook config | ✅ Verified live |
| gowa runs unmodified for all of the above — **no fork needed** | ✅ |

## Still open

| # | Question | Needs | Status |
| --- | --- | --- | --- |
| 1 | Marginal memory per connected device | A second paired number | ~55 MiB, **unconfirmed** |
| 2 | Socket-drop detection and recovery latency | — | ✅ **Done** — 203 s detect, 2.1 s recover |
| 3 | Does a lifecycle event *ever* reach a webhook? | — | ✅ **Done — NO. Proven.** |
| 4 | Do all six v1 types send? | — | ✅ **Done** |
| 4b | Do all six v1 types arrive inbound? | Image + text observed; `is_from_me` both ways observed; other media shapes derived from source | ✅ **Done** |
| 5 | Does an incoming call ring the phone with gowa doing nothing? | — | ✅ **Done** — `auto_rejected: false`, no reject attempted |
| 6 | Two slots racing for the same number | Two slots, one number | Open — risky, do late |
| 7 | Does the per-device webhook setter replace or append? | — | ✅ **Done** — `PATCH`, replaces, clears omitted fields |
