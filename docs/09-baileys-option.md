# 09 — Option study: Baileys as the base SDK

*Explores: "use Baileys as the base SDK, check what gowa has, and recreate it."*

> **Historical, kept deliberately.** Stage 4 removed gowa; this document studies
> it. It is retained because most of what is here is the evidence for decisions
> that still stand rather than documentation of a dependency — delete the
> measurement and the design it justifies looks arbitrary. `reference/gowa/…`
> paths cite a read-only clone that was never committed and no longer exists;
> read them as citations into [gowa's repository](https://github.com/aldinokemal/go-whatsapp-web-multidevice).
> See [docs/README](README.md).

## Summary

The instinct is right; the framing is what makes it expensive.

**"Recreate gowa on Baileys"** is 8–12 weeks of work that produces nothing a
customer can see. **"Implement `DeviceEngine` on Baileys"** is 3–5 weeks and
produces the same strategic result — because bunwa only needs about 15% of
gowa's surface from its engine. Everything else gowa does, bunwa either does
itself or does not want.

That difference comes entirely from [ADR-0002](adr/0002-engine-adapter.md)
existing first. Without the interface you must match gowa feature-for-feature,
because you have no definition of "done". With it, "done" is the conformance
suite, and it is small.

## What the engine actually has to do

gowa is 51k lines. Here is what a native engine must reproduce, and what it must
not bother with:

| gowa area | LOC | Needed in a bunwa engine? |
| --- | --- | --- |
| Chatwoot integration | 6,400 | ❌ Out of scope ([02](02-requirements.md)) |
| Chat storage / history | 3,900 | ❌ Out of scope — projects own their data |
| MCP server | ~1,500 | ❌ Not a requirement |
| REST handlers, validation, DTOs | ~10,600 | ❌ bunwa's own API replaces this entirely |
| Fiber app, middleware, dashboard asset serving | ~1,600 | ❌ Replaced |
| Webhook forwarding + filtering | 1,600 | ❌ **bunwa does this, per link** |
| Auto-reply | 112 | ❌ bunwa's rule engine replaces it |
| Device manager / lifecycle | ~1,400 | ✅ **Yes** |
| Event handling + normalisation | ~2,000 | ✅ **Yes**, but only the ~17 types bunwa emits |
| Send paths (all message types) | ~1,800 | ✅ **Yes** |
| Group operations | ~1,200 | ✅ Yes |
| User / profile queries | ~600 | ✅ Yes |
| Media handling | ~800 | ✅ Yes |
| Utilities, JID handling, presence pulse | ~1,500 | ✅ Partially |

**Engine-relevant: roughly 9,000 lines of Go.** Written in TypeScript against a
library that already handles the protocol, and with the interface already
defining the boundary, that is a realistic 3,000–4,000 line module.

That reframing is the single most useful output of this study. "Port 51k lines
of Go" and "write a 3.5k-line adapter" are different projects.

## What Baileys gives you for free

Verified against current documentation:

| Capability | Baileys |
| --- | --- |
| All send types — text, media, location, contact, poll, reactions, quoted, mentions | ✅ `sock.sendMessage` with a content union |
| Group management — create, participants, promote/demote, settings, invite links | ✅ `groupSettingUpdate`, `groupParticipantsUpdate`, … |
| Newsletters / broadcast | ✅ |
| Privacy settings | ✅ `updateProfilePicturePrivacy` and siblings |
| Labels | ✅ `labels.edit`, `labels.association` events |
| Business profile | ✅ |
| Presence, typing | ✅ |
| Connection lifecycle | ✅ `connection.update` — **raw**, see below |

Feature parity with what bunwa needs is not the problem. Baileys covers it.

## What Baileys does *not* give you

This is where the estimate lives. Every item below is something whatsmeow plus
gowa already solved and you would be re-solving.

### 1. Auth state persistence (highest risk)

Baileys ships `useMultiFileAuthState`, and its own documentation is explicit that
it is a demo, not a production store. You need a real one — per device, in
the project's own database, correctly handling the Signal key store's read/write pattern.

This is not boilerplate. The key store sits on the hot path of every message
decrypt; a naive implementation that round-trips to the database per key will
collapse under load, and a subtly wrong one corrupts sessions in ways that
present as "some messages from some contacts never arrive." whatsmeow's SQL
store has years of production behind it.

Budget: 1 week to write, and an unbounded tail of edge cases.

### 2. The reconnection state machine

`connection.update` hands you a raw disconnect with a Boom status code. Mapping
those to *retry / do not retry / re-pair required*, with bounded backoff, is
yours to write — and getting it wrong means either a device that never
reconnects, or a reconnect loop that gets the number banned.

gowa's equivalent logic, plus its presence pulse, is roughly 1,400 lines that
exist because of production incidents.

### 3. Message normalisation

WhatsApp has around forty message shapes, and they nest: `viewOnceMessage`
wrapping `imageMessage`, `ephemeralMessage` wrapping `extendedTextMessage`,
`protocolMessage` carrying edits and revokes, `documentWithCaptionMessage`,
and so on. gowa's `utils.UnwrapMessage` and its event handlers exist to flatten
this. Poll votes need separate decryption entirely.

Miss a wrapper and you silently drop messages of that type. Budget a week, and
port gowa's unwrapping logic as a specification.

### 4. Group metadata caching

Sending to a group requires its metadata. Fetch it per send and you will hit
rate limits and get flagged. Baileys exposes `cachedGroupMetadata` as a hook —
you supply the cache and its invalidation.

### 5. Media pipeline

Upload with retry, download with re-request on failure, thumbnail generation,
streaming for large files, and the media-retry protocol for messages whose media
has expired.

### 6. The accumulated guard logic

gowa's [`auto_reply.go`](../reference/gowa/src/infrastructure/whatsapp/auto_reply.go)
spends most of its length deciding whether to respond *at all*: skip groups,
skip broadcasts, skip `status@`, skip own messages, require genuinely typed text
rather than a caption or a synthetic label. Every one of those clauses is a
lesson. Port them.

### 7. Density and isolation

One Baileys socket per device, in one Bun process, means one device's unhandled
rejection can take the process down — the same problem as gowa's
`os.Exit(0)`, in a different language. [ADR-0003](adr/0003-process-isolation.md)
applies identically to the native engine, so the worker-pool machinery is needed
either way.

## Realistic estimate

| Work | Estimate |
| --- | --- |
| `DeviceEngine` implementation over Baileys | 1 wk |
| Postgres auth-state store | 1 wk |
| Connection state machine + backoff | 1 wk |
| Message normalisation (all wrappers, polls) | 1–2 wk |
| Media pipeline | 1 wk |
| Groups, users, presence | 1 wk |
| Worker pool, isolation, recycling | 1 wk |
| Conformance suite to green | 1–2 wk |
| Shadow-mode soak and migration | 2–3 wk |
| **Total** | **10–13 weeks** |

Compare with the gowa adapter — HTTP client, event bridge, reconciler — at
**2–3 weeks**, most of which is the reconciler you want regardless.

## The protocol-risk trade

Restating the point from [00](00-assessment.md), because it is the part that
does not show up in a line count:

| | whatsmeow (via gowa) | Baileys (native) |
| --- | --- | --- |
| Update cadence | gowa's pin was one day old at time of writing | Active, but 7.x is still at release candidate |
| Who fixes a WhatsApp protocol change | tulir + gowa's maintainer | Rajeh + you |
| Your exposure | One dependency bump | Your own fork, if the fix is slow |

Choosing Baileys is choosing whose response time your uptime depends on. That is
a legitimate choice — Evolution API, WAHA and WaSphere all made it — but it
should be made deliberately, and it is a poor thing to be exposed to during the
weeks when you are also debugging your first multi-tenant consent flow.

## Verdict

| Framing | Score | When |
| --- | --- | --- |
| "Recreate gowa on Baileys" as stage 2 | **3 / 10** | Never — wrong scope, wrong order |
| "Implement `DeviceEngine` on Baileys" as stage 4 | **8 / 10** | Once the interface, the conformance suite and the product exist |
| Baileys as a *second* engine, permanently alongside gowa | **9 / 10** | The end state worth aiming for |

The last row is the interesting one. Two engines is not a transitional
embarrassment — it is a hedge. When WhatsApp breaks one library, you migrate
affected devices to the other with `POST /admin/v1/devices/{id}/migrate` and
keep serving traffic. Very few WhatsApp gateways can do that, and the
architecture in [03](03-architecture.md) gets it almost for free.

## Recommendation

Keep the plan in [08](08-roadmap.md). Change only the vocabulary of stage 4:
it is not "the rewrite", it is "the second engine". Build it when one of the
entry criteria is met, size it at 3.5k lines rather than 51k, and keep gowa
permanently as the fallback.
