# 00 — Project assessment

*Written 2026-08-22, against gowa `main` @ `0427b9f` (whatsmeow pinned 2026-08-21).*

## Verdict

**Worth building: 7.5 / 10 — but not in the order proposed.**

The three problems identified are real, and I verified all three in gowa's source
rather than taking them on trust. The many-projects-to-many-devices layer is
genuinely unserved by anything on the market, and it is the part with actual
commercial value.

The weak link is stage 2 as written: *"convert the server side from Go to Bun."*
That stage carries the highest risk, takes the longest, and delivers the least
user-visible value of the four. It should be demoted from a prerequisite to an
optional, isolated swap — and everything else should be built before it.

| Objective | Verdict | Why |
| --- | --- | --- |
| Lifecycle events not delivered (#1) | ✅ Confirmed, worth fixing | Solvable in days, not weeks. Does not require a rewrite. |
| No message trigger engine (#2) | ✅ Confirmed, worth building | gowa's auto-reply is a single global static string. Genuine greenfield. |
| Many projects → many devices (#3) | ✅ Confirmed, **the real product** | Nothing open-source models this. This is the differentiator. |
| Rewrite Go → Bun (stage 2) | ⚠️ Do last, and only partially | 51k LOC, and it means trading whatsmeow for Baileys. See [ADR-0002](adr/0002-engine-adapter.md). |

## The evidence

### #1 — Lifecycle events never reach the outside world

Confirmed, and worse than described. In
[`event_handler.go:219`](../reference/gowa/src/infrastructure/whatsapp/event_handler.go),
`handleLoggedOut` ends like this:

```go
websocket.Broadcast <- websocket.BroadcastMessage{
    Code:    "DEVICE_LOGGED_OUT",
    Message: "Device logged out (slot kept)",
    Result:  map[string]string{"device_id": deviceID},
}
```

That is an internal browser WebSocket broadcast. It is not a webhook. The
documented webhook catalogue in
[`docs/webhook-payload.md`](../reference/gowa/docs/webhook-payload.md) lists 17
events — `message`, `message.ack`, `group.participants`, `call.offer`, and so
on — and **not one of them is a session lifecycle event**. Cross-checking the
code agrees: every `forward*ToWebhook` function in
`src/infrastructure/whatsapp/` covers messages, receipts, groups, labels,
newsletters and calls. There is no `forwardLoggedOutToWebhook`.

The practical consequence: if a customer unlinks their phone at 02:00, your
backend finds out when a send call fails, not when it happens.

I also found a related hazard in the same file:

```go
func handleStreamReplaced(_ context.Context) {
    os.Exit(0)
}
```

One device's stream being replaced terminates the **entire process** — and with
it every other device in that instance. For a single-tenant deployment that is
merely rude. For a shared multi-tenant proxy it is unacceptable, and it is a
structural argument for process isolation regardless of implementation language.
See [ADR-0003](adr/0003-process-isolation.md).

### #2 — No trigger engine

Confirmed. gowa's entire automation surface is
[`auto_reply.go`](../reference/gowa/src/infrastructure/whatsapp/auto_reply.go),
gated on one global config string:

```go
if config.WhatsappAutoReplyMessage == "" {
    return
}
```

One reply, one text, all devices, all senders, no matching, no conditions, no
per-project behaviour. There is nothing to extend — this is greenfield work.

### #3 — Multi-device, but single-tenant

gowa handles multiple devices well: `DeviceManager`
([961 lines](../reference/gowa/src/infrastructure/whatsapp/device_manager.go))
manages slots, keep-slot logout, companion claims, and per-device store rows.
Recent versions even added **per-device webhook config**
(`GetDeviceWebhookConfig`, `POST /devices/{id}/webhook`), which is more than I
expected and genuinely useful.

But the model is `device → one webhook config`. There is no concept of a tenant,
no per-project API key (auth is a single global `AppBasicAuthCredential`), and
no way for one WhatsApp identity to serve two consumers with different
permissions and different endpoints. gowa's unit of isolation is the *device*;
you need the unit of isolation to be the *(project, device) pair*.

That gap is the project.

## What already exists (the "easier solution" question)

I looked at this seriously, because the cheapest project is the one you don't
write.

| Option | Multi-device | Per-instance webhooks | Many-projects-per-device | Verdict |
| --- | --- | --- | --- | --- |
| **gowa** (as-is) | ✅ | ✅ | ❌ | Great engine, no tenancy |
| **[Evolution API][evo]** | ✅ | ✅ | ❌ | Instance = session. Same ceiling. |
| **[WAHA][waha]** | ✅ | ✅ | ❌ | Docker-first, swappable engines. Same ceiling. |
| **wppconnect-server** | ✅ | ✅ | ❌ | Same ceiling. |
| **Meta Cloud API** | N/A | ✅ | ❌ | Official, but requires business verification, per-message fees, and cannot use a customer's own personal number — which is the whole point here. |

Every open-source option converges on the same model: **one instance = one
session = one consumer**. They differ in polish, not in topology. None of them
lets a customer pair a device once and then consent to reuse it across several
of your products.

So the honest summary: **80% of what you need is a solved commodity, and the
remaining 20% is not available at any price.** That is a good shape for a
project — provided you build the 20% and buy the 80%, rather than rebuilding
the 80% first.

## The recommended change of plan

The proposed stage order front-loads the rewrite:

```
learn gowa → rewrite Go→Bun → port dashboard → add features
                    ▲
              6+ months before the first thing you actually need works
```

Invert it. Treat gowa as a **replaceable data plane behind an adapter
interface**, and build the control plane — the part nobody else has — first:

```
learn gowa → control plane over gowa → dashboard → native engine (optional) → features
                        ▲
              needs #1, #2, #3 all satisfied here, in weeks
```

This is not a rejection of the Bun rewrite. It is a re-ordering that makes the
rewrite *safe*: once `DeviceEngine` is a real interface with a working gowa
implementation behind it and a conformance test suite in front of it, a native
Bun engine becomes a swap you can do one device at a time, measure, and roll
back. Attempting it first means porting 51k lines of Go with no reference
behaviour to test against and no product to show for it.

Concretely, what the re-ordering buys:

- **#1 is solved without touching gowa's internals.** bunwa's gowa adapter
  subscribes to gowa's `/ws` (which *does* broadcast `DEVICE_LOGGED_OUT`,
  `LOGIN_SUCCESS`, `QRDATA`, `PASSKEY_*`) and reconciles it against polled
  `/devices/{id}/status`, then emits proper `device.*` webhook events. See
  [05 — Events and rules](05-events-and-rules.md).
- **#2 and #3 live in the control plane anyway.** They gain nothing from the
  engine being written in TypeScript.
- **You keep whatsmeow.** Which matters more than it sounds — see below.

## The risk you must price in: whatsmeow vs Baileys

This is the single most consequential technical fact in the whole plan.

| | [whatsmeow][wm] (gowa uses this) | [Baileys][bail] (a Bun rewrite must use this) |
| --- | --- | --- |
| Language | Go | TypeScript |
| Version in gowa | pinned `2026-08-21` — **yesterday** | — |
| Stable line | continuously released | 6.7.23 (May 2026) |
| Next major | — | 7.x still at **release candidate** (`7.0.0-rc13`) |
| Licence | MPL-2.0 | MIT |

WhatsApp changes its protocol without notice, and when it does, your gateway
stops working until the library catches up. You are not choosing a programming
language here; you are choosing **which maintainer's response time your uptime
depends on**. gowa's whatsmeow pin being one day old is not a trivia point — it
is evidence of the update cadence you would be giving up.

Baileys is a capable, widely-deployed, MIT-licensed library and Evolution API,
WAHA and WaSphere all ship on it, so this is far from disqualifying. But
"rewrite in Bun" quietly means "re-base your protocol risk onto a different
project whose 7.x line has not shipped stable yet," and that deserves to be a
conscious decision rather than a side effect of a language preference.

## Where this could go wrong

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Protocol breakage from WhatsApp | High | Engine adapters; keep the gowa engine as a fallback permanently, not just during migration |
| Account bans from automation patterns | High | Rate limiting, presence pulse, humanised delays, per-link quotas from day one — not bolted on later |
| Consent model gets legally interesting | Medium | Explicit, revocable, audited consent per link. Data-scoping so project A never sees project B's chats. See [04](04-data-model.md). |
| Scope creep into "build a CRM" | Medium | bunwa is a proxy. Chatwoot integration, chat storage and history sync are explicitly **out of scope** — see [02](02-requirements.md). |
| Rewrite stalls at 70% and nothing is shippable | High | This is precisely what the re-ordering prevents |

## If you only take one thing from this document

Build the **control plane**, not the **client**. The client is a commodity you
can rent from gowa today and replace later; the control plane is the thing you
actually need and cannot buy.

---

Sources consulted for the ecosystem comparison:
[Baileys on npm](https://www.npmjs.com/package/@whiskeysockets/baileys) ·
[Baileys releases](https://github.com/WhiskeySockets/Baileys/releases) ·
[Open source WhatsApp API: the 2026 landscape](https://wasphere.com/blog/open-source-whatsapp-api-landscape-2026/) ·
[Evolution API alternatives, tested](https://www.indiehackers.com/post/best-10-evolution-api-alternatives-in-2026-tested-9fc702d744)

[gowa]: https://github.com/aldinokemal/go-whatsapp-web-multidevice
[evo]: https://github.com/EvolutionAPI/evolution-api
[waha]: https://waha.devlike.pro/
[wm]: https://github.com/tulir/whatsmeow
[bail]: https://github.com/WhiskeySockets/Baileys
