# 11 — Engine decision: gowa or Baileys?

*Re-decided 2026-08-22 against the narrowed requirements. Supersedes the
provisional answer in [09](09-baileys-option.md), which assumed full gowa
feature parity.*

> **2026-08-25.** The condition below — "start once the control plane is live"
> — is met. Stages 0 through 2 are merged, so Baileys is now a committed stage
> 4 rather than a planned one. See the amendment to
> [ADR-0007](adr/0007-gowa-engine-for-v1.md) for what the merged tree measured
> and which obligations transfer with the pivot. The analysis below is unchanged
> and still explains why gowa was right for v1.
>
> **2026-08-27.** Stage 4 shipped. Baileys is the engine, gowa is deleted, and
> the two-image topology sketched below is not how it was built — there is one
> process, and the `api`/`full` split is now whether the console page is
> imported. Everything else stands: the size estimate for a `DeviceEngine` on
> Baileys was roughly right, and the reason to choose gowa first — get the
> control plane built without also writing a WhatsApp client — is why the pivot
> was cheap when it came. `reference/gowa/…` paths cite a clone that no longer
> exists.

## Decision

**gowa for v1 — unmodified, on container loopback. Baileys as engine #2,
promoted from "optional stage 4" to "planned, start once the control plane is
live".**

The narrowed scope moved this much closer than it was. It did not flip it, and
the reason is what you are sending.

## What changed, and which way each fact pushed

| New requirement | Pushes toward |
| --- | --- |
| Only 6 message types: text, image, PDF, link-preview, audio, video | **Baileys** — the send surface was most of the porting cost |
| No group management in scope | **Baileys** — cuts ~1,200 lines of gowa relevance |
| No chat storage, no history sync | **Baileys** — already out of scope, now confirmed |
| Calls must be ignored entirely | **Neutral** — trivial in both |
| Ship one container, api or api+dashboard | **Baileys** — one runtime, no supervisor, no fork |
| Devices are system-owned, not customer-owned | **Neutral** — a control-plane concern |
| **Primary use case is OTP delivery** | **gowa** — decisively |

### The scope cut is real

Under the original assumption the native engine was ~3,500 lines. Under these
requirements it is closer to **2,000–2,500** — six send paths, six inbound
types, no groups, no newsletters, no labels, no privacy, no business profile, no
history. That is 4–6 weeks, not 10–13. The Baileys option got substantially
cheaper and I should say so plainly.

### OTP is what settles it

"Plain message, e.g. OTP number" is listed first, and OTP is the least
forgiving traffic there is. A marketing message that arrives ten minutes late is
an inconvenience. An OTP that arrives ten minutes late is a login that failed,
a customer who churned, and a support ticket — per user, at the exact moment
they were trying to use the product.

WhatsApp changes its protocol without notice. When it does:

| | With gowa | With your own Baileys engine |
| --- | --- | --- |
| Who diagnoses it | tulir (whatsmeow) + gowa's maintainer | You |
| Who ships the fix | Upstream, usually fast — gowa's pin was 1 day old | You |
| Your action | `docker pull` | Debug Signal protocol while OTPs fail |
| Time to recovery | Hours | Unknown |

For a side project with one maintainer, owning the protocol layer means owning
that pager. The value bunwa creates is in tenancy, consent and routing — none of
which is improved by also owning protocol maintenance.

### And the send surface already exists

All six required types map to endpoints gowa ships today, in production, tested:

| Requirement | gowa endpoint |
| --- | --- |
| Plain message (OTP) | `POST /send/message` |
| Image | `POST /send/image` |
| PDF | `POST /send/file` |
| URL with image preview | `POST /send/link` |
| Audio | `POST /send/audio` |
| Video | `POST /send/video` |

Zero engine work for v1's entire messaging requirement. With Baileys, each is a
small amount of work — but "small × six, plus media handling, plus link-preview
metadata fetching" is still weeks you would spend before sending your first OTP.

### Calls: ignore is already the default

Verified in
[`event_call.go:19`](../reference/gowa/src/infrastructure/whatsapp/event_call.go):

```go
if config.WhatsappAutoRejectCall {   // default: false
```

gowa rejects a call only when explicitly configured to. Leave
`WHATSAPP_AUTO_REJECT_CALL` unset and gowa observes the offer, logs it, and does
nothing — which is exactly the requirement. bunwa additionally drops `call.offer`
from the default event filter so projects are not notified either.

Worth understanding *why* this works: a companion session does not intercept
calls. The offer rings on every linked device including the customer's phone,
and doing nothing leaves the phone to handle it. There is no "let it through"
action to implement — inaction is the correct behaviour.

## The change this forces to the container plan

[Doc 10](10-single-container.md) proposed a Unix socket, which required three
patches to gowa, because Bun's WebSocket client cannot dial a socket file.

Given "ship one image", the better v1 answer is simpler:

**Run gowa unmodified on `127.0.0.1` inside the container.**

| | Unix socket | Loopback in-container |
| --- | --- | --- |
| gowa patches needed | 3 (~120 lines) | **0** |
| Fork to maintain | Yes | **No** |
| `/ws` lifecycle bridge | ❌ Impossible — forces patch 3 | ✅ Works |
| Port exposed outside container | No | No — loopback is namespace-local |
| Reachable by other processes | No (file permissions) | Yes, within the namespace |

The isolation difference is real but small: inside a single-purpose container the
namespace contains your two processes and nothing else. Trading that for **zero
fork** is clearly right for v1. `docker pull` stays a one-word upgrade path,
which is the whole reason gowa was chosen.

The Unix socket work stays specified in [10](10-single-container.md) and remains
worth doing — later, upstream, as PRs rather than as a fork.

## v1 container layout

```
┌──────────── bunwa:api ────────────┐   ┌──── bunwa:full ────┐
│  bunwa (Bun)        :3000 exposed │   │  bunwa:api         │
│  gowa (Go)          127.0.0.1:3100│   │  + dashboard (SPA) │
│  s6-overlay supervises both       │   │    served at /app  │
└───────────────────────────────────┘   └────────────────────┘
        │                    │
   SQLite (one file)
```

Two published tags from one build. The dashboard is a separate subproject
(`dashboard/`) with its own build, copied into the `full` image and absent from
`api`. See [07](07-dashboard.md).

## When to build the Baileys engine

Start it once the control plane is live and stable — not before, and not never.
Concrete triggers, any one sufficient:

1. A required capability is unreachable through gowa's HTTP API
2. gowa's release cadence blocks you on a bug you have already reported
3. Per-device memory via gowa limits density below your target
4. Operating two runtimes has become a measurable cost
5. You want the fallback: **two engines means a WhatsApp change that breaks one
   library is survivable by migrating devices to the other**
6. The 203-second socket-drop detection latency measured in
   [12](12-stage0-findings.md) becomes unacceptable. Through gowa the keepalive
   interval is whatsmeow's choice; in a native engine it is ours.

Trigger 5 is the ambitious version and it is the one worth aiming at. Under
these narrowed requirements a second engine is ~2,000 lines, and
`POST /admin/v1/devices/{id}/migrate` already exists in the design to move
devices between them. Very few WhatsApp gateways can fail over across two
independent protocol implementations.

## Scores

| Option | v1 | End state |
| --- | --- | --- |
| gowa only | **8 / 10** | 6 / 10 — permanent upstream dependency |
| Baileys only | 5 / 10 — 4–6 weeks before the first OTP sends | 7 / 10 |
| gowa now, Baileys second | **9 / 10** | **9 / 10** |

Unchanged in conclusion from [09](09-baileys-option.md), but for different and
stronger reasons, and with the timeline for engine #2 pulled forward.
