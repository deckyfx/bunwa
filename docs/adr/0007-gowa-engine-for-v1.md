# ADR-0007 — gowa is the v1 engine; Baileys is engine #2

**Status:** **Superseded 2026-08-27** by the completion of stage 4 · Accepted
2026-08-22 · Amended 2026-08-25 · Superseded the provisional position in
[ADR-0002](0002-engine-adapter.md) on *when* the native engine arrives

> **Superseded, 2026-08-27.** gowa is not the engine. Stage 4 finished, Baileys
> replaced it, and the adapter, the harness, the compose stack and the
> reference clone were deleted. The last line of this document — "the gowa
> adapter stays" — is the specific thing that was reversed; the reasoning is in
> the amendment to [ADR-0002](0002-engine-adapter.md).
>
> Nothing below is edited. The v1 decision was right for v1, and the two facts
> it rested on are why the control plane got built at all rather than being
> half-built behind a WhatsApp client. The obligations it listed as transferring
> with a pivot — session state, in-process sockets, the 203-second window — are
> the correct list, and it is worth noting which of the three has actually been
> discharged: session state has (see [13](../13-owning-the-data.md)); the other
> two have not.

> **Amendment, 2026-08-25.** The conditional framing below — Baileys "if and
> only if" gowa becomes a bottleneck — is withdrawn. Baileys is now a committed
> stage 4, and the reasoning is in the amendment at the end of this document.
> Everything above that section is preserved as the v1 decision it was, because
> the v1 decision was correct and the reasons it was correct still explain the
> shape of the system.

## Context

The v1 requirements narrowed considerably: six message types (text, image, PDF,
link preview, audio, video), no groups, no chat storage, calls explicitly
ignored, and a single-container deliverable in two flavours (`api`, `api+dashboard`).

That cut most of what made a native engine expensive. The estimate for a Baileys
`DeviceEngine` fell from ~3,500 lines and 10–13 weeks to ~2,000–2,500 lines and
4–6 weeks ([11](../11-engine-decision.md)). The decision genuinely reopened.

Two facts decided it:

1. **The primary use case is OTP.** A late or missing OTP is a failed login, per
   user, at the moment of highest intent. It is the least forgiving traffic
   there is, and it makes protocol-maintenance response time a product
   requirement rather than an engineering preference.
2. **All six required send types already exist in gowa** as tested endpoints:
   `/send/message`, `/send/image`, `/send/file`, `/send/link`, `/send/audio`,
   `/send/video`. v1's entire messaging requirement needs zero engine work.

## Decision

**gowa is the v1 engine, running unmodified on container loopback.**

Specifically, and departing from [ADR-0006](0006-unix-socket-transport.md) for
v1: no Unix socket, no patches, **no fork**. gowa runs on `127.0.0.1:3100`
inside the container; bunwa is the only thing that can reach it, and the only
exposed port is bunwa's own. The `/ws` lifecycle bridge works again, because the
Bun WebSocket limitation only applied to socket files.

Calls are ignored by leaving `WHATSAPP_AUTO_REJECT_CALL` at its default of
false, and by excluding `call.offer` from the default event filter.

The Baileys engine is **promoted from optional to planned**, to start once the
control plane is live, against the triggers listed in
[11](../11-engine-decision.md).

## Consequences

**Good**

- Zero engine work for v1's messaging requirement
- No fork; upgrading the engine is `docker pull`
- whatsmeow's release cadence covers the OTP path during the riskiest period
- The `/ws` bridge survives, so lifecycle events need no gowa change and **no
  fork is required for v1**
- Ships as one container immediately

**Bad**

- Two runtimes in one image, and a supervisor (`s6-overlay`) to order and
  restart them
- Image size grows by gowa's Go binary
- A dependency on an upstream roadmap you do not control
- gowa keeps its own SQLite device store alongside bunwa's Postgres — two
  sources of truth about a device, reconciled by the adapter rather than by a
  constraint
- `/ws` is an internal, unversioned channel; a gowa upgrade may change its
  broadcast codes without notice. Mitigated by treating it as an optimisation
  over the status poller and contract-testing it in CI
  ([05](../05-events-and-rules.md))
- The colocated topology hosts one engine pool, so it does not scale past that
  pool's device count ([ADR-0003](0003-process-isolation.md))

**Deferred, not abandoned:** the Unix socket transport and the three gowa
patches from [ADR-0006](0006-unix-socket-transport.md) remain worthwhile, and
should be pursued as upstream pull requests rather than as a maintained fork.

---

## Amendment · 2026-08-25 · Baileys becomes a committed stage 4

The original decision was "gowa for v1, Baileys if it earns its way in". v1 is
built, so the condition it was waiting on has been answered a different way: the
job gowa was chosen to avoid — writing a WhatsApp client while also writing a
control plane — is no longer the thing at risk. The control plane exists, is
tested, and is engine-agnostic.

### What the merged tree actually shows

Not an estimate. Measured on stage-2 at merge:

- `DeviceEngine` is seven methods.
- Coupling to gowa outside `src/engine/gowa/` is **14 lines across six files**.
  Five of those are the composition root, where coupling belongs. The only real
  leak is a hardcoded `choosePool("gowa", …)` in the pairing route.
- The conformance suite runs against any engine through a harness, so a new
  adapter inherits eight behavioural guarantees on day one.

The abstraction ADR-0002 argued for held under two stages of pressure. That is
the evidence that made this reopenable without it being a rewrite.

### What has not changed, and must not be waved through

The original decision rested on OTP being unforgiving traffic and on
protocol-maintenance response time being a product concern. Both still hold, and
Baileys being unofficial does not make them go away. Three obligations transfer
to bunwa with the pivot:

1. **Session state.** gowa owns multi-device credentials today. Under Baileys,
   bunwa owns them: encrypted at rest, per device, surviving restart and
   restore-from-backup. Losing them means every customer re-pairs. This is the
   highest-consequence data in the system and it does not exist yet.
2. **In-process sockets.** `enginePoolId` bounds blast radius because a gowa
   container is a separate process ([ADR-0003](0003-process-isolation.md)).
   In-process, a pool no longer means what it meant.
3. **The 203-second blind window** ([12](../12-stage0-findings.md)) is a *gowa*
   measurement, and the ack timeout exists because of it. Baileys may be far
   better. Stage 0 gets re-run rather than assumed.

### The constraint that makes this survivable

Baileys moves quickly and breaks. One module —
`src/engine/baileys/socket.ts` — may import from the library; the adapter
depends on that port and never on library types, and no Baileys type appears in
a `DeviceEngine` signature. A path instruction and a test enforce it, so an
import added elsewhere fails rather than being discovered during an upgrade.

### Consequence

The gowa adapter stays. Two working engines is the failover ADR-0002 described,
it costs one directory, and it is the cheapest insurance available against a
Baileys regression on OTP traffic.
