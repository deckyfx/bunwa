# 08 — Roadmap

## Re-sequencing, and why

The brief proposed:

```
1. learn gowa → 2. Go→Bun rewrite → 3. dashboard → 4. features
```

The plan below keeps all four pieces of work but changes their order, for the
reasons argued in [00 — Assessment](00-assessment.md): the rewrite is the
riskiest, slowest, least valuable stage, and putting it second means roughly six
months before anything you actually need exists.

```
0. learn gowa
1. control plane over gowa      ← #1, #2, #3 all solved here
2. hardening + production
3. dashboard
4. native Bun engine            ← the rewrite, de-risked, optional, per-device
5. features
```

| Brief's stage | Becomes | Why it moved |
| --- | --- | --- |
| 1 — learn gowa | Stage 0 | Unchanged |
| 2 — Go→Bun | Stage 4 | Behind an adapter, it is a swap rather than a prerequisite |
| 3 — dashboard | Stage 3 | Unchanged in position; now sits on a working API |
| 4 — features | Stage 5 | Unchanged |
| *(new)* | Stages 1–2 | The actual product: tenancy, consent, events, rules |

Nothing is dropped. The rewrite still happens — it happens when it is cheap and
reversible instead of expensive and irreversible.

---

## Stage 0 — Understand gowa

**Goal:** know the system you are replacing well enough to argue with it.
**Estimate:** 1 week.

- [x] Clone gowa read-only into `reference/gowa`
- [x] Map architecture, layering, and event flow → [01](01-gowa-architecture.md)
- [x] Confirm all three claimed limitations in source, not by assumption
- [x] Run gowa locally in Docker; pair a real device
- [x] Measure memory and file descriptors per connected device (open question 2)
- [x] Measure how long whatsmeow takes to notice a dropped socket (open question 3)
- [x] Verify `/ws` broadcast behaviour with two devices, one logging out
- [x] Verify `POST /devices/{id}/webhook` semantics: replace or append?

**Exit criteria:** a device paired to a local gowa, receiving webhooks, and a
written measurement of per-device cost. Those numbers set the deployment
topology in [03](03-architecture.md) and cannot be guessed.

**Status: done.** Every measurement is in [12](12-stage0-findings.md), which
remains the most load-bearing document here — the 203-second gap between a
silent disconnect and the engine admitting it is why a send is confirmed by an
ack rather than by acceptance, and that design outlived the engine it was
measured against. The harness that produced those numbers (`src/tools/`, the
compose stack under `deploy/stage0/`, and the `reference/gowa` clone) was
deleted with gowa in stage 4. The numbers are what mattered; the scripts that
produced them measured a dependency that no longer exists.

---

## Stage 1 — Control plane over gowa

**Goal:** all three limitations solved, with gowa still doing the protocol work.
**Estimate:** 6–8 weeks. **This is the stage that delivers the product.**

### 1.1 — Foundation (week 1)

- Elysia server, typed config, structured logging with correlation ids
- Postgres + Drizzle, initial migration
- Project entity, API keys, auth middleware
- Health and readiness endpoints
- CI: typecheck, lint, test, OpenAPI diff *(typecheck + test + a
  runtime-data guard landed in stage 0; lint and the OpenAPI diff remain)*

### 1.2 — Engine abstraction (weeks 2–3)

- `DeviceEngine` interface ([03](03-architecture.md))
- gowa adapter: HTTP client over container loopback, **gowa unmodified**
  ([ADR-0007](adr/0007-gowa-engine-for-v1.md))
- gowa adapter: `/ws` bridge + status poller + **state reconciler**
- Container: s6-overlay supervising bunwa + gowa, `bunwa:api` tag building
- **Conformance suite** — the contract's teeth; written now, reused in stage 4
- Engine pool registry and health tracking

### 1.3 — Tenancy and consent (weeks 3–4)

- Projects, environments, API keys, devices, virtual devices, consents
- `POST /v1/devices/claim` with all three outcomes
- WhatsApp challenge: send, parse the reply, handle expiry — the primary channel
- Dashboard token approval as the secondary channel
- Consent granted per (device, project); environments inherit
- Revocation, immediate, without disturbing the device's other projects
- Immutable consent audit log with reply evidence
- Postgres RLS policies

### 1.4 — Events and delivery (weeks 4–6)

- Normalised event schema `bunwa.event/v1`
- **Lifecycle event synthesis** — limitation #1 closed
- Per-virtual-device fan-out with scope, allowlist, denylist and type filtering
- SQLite-backed per-virtual-device delivery queues, retry, backoff, DLQ
- Timestamped HMAC signatures
- SSE endpoint

### 1.5 — Messaging (weeks 5–7)

- `POST /v1/devices/{ref}/messages` — the six v1 types only: text, image,
  document, link, audio, video
- Idempotency keys — mandatory, and the OTP path's safety net
- Inbound normalisation for the same six types
- Media validation: type, size, PDF page count
- Per-virtual-device quotas and rate limits
- Calls: verify inaction end to end — `WHATSAPP_AUTO_REJECT_CALL` unset,
  `call.offer` filtered out, a real call to a paired device rings the phone
  normally and bunwa does nothing

### 1.6 — Rules (weeks 7–8)

- Rule storage, versioning, priority ordering
- Match evaluator with RE2-only patterns and the three safety mitigations
- Actions: reply, send, forward, tag, suppress, set_var
- Loop protection: origin marking, depth cap, rate limit, circuit breaker
- Dry-run endpoint — limitation #2 closed

**Exit criteria**

1. One physical device serving `grande/production` and a second project, each
   with its own webhook, filters and rules, neither able to observe the other.
2. A number already paired for project A, claimed by project B, sends a WhatsApp
   challenge; a `YES` reply activates the binding with no re-scan.
3. The same number claimed by `grande/staging` after `grande/production` already
   holds consent activates **immediately, with nothing asked of the customer**.
4. Unlinking the phone produces `device.logged_out` on every bound environment's
   webhook within 5 seconds.
5. An OTP send is idempotent under retry, and delivers p95 < 2 s.
6. An incoming call rings the customer's phone and bunwa neither answers nor
   rejects it.
7. Killing the gowa process degrades only its devices; s6 restarts it and the
   control plane recovers without a restart.

Those four sentences are the whole project. Everything after this stage is
polish, scale, or optionality.

---

## Stage 2 — Hardening

**Goal:** survive the failures that are actually likely, and know when the
architecture stops coping.
**Estimate:** 2–3 days.

This section was three to four weeks until it was read properly. It had been
written as a generic production-hardening checklist — Prometheus, OpenTelemetry,
chaos engineering, 24-hour soaks, runbooks — without first asking who the
tenants are and what can realistically go wrong. Most of it was defending
against a threat model this project does not have.

The pruned list is what is left after asking, of each item, *what breaks if we
skip this, and how likely is that?*

### Do now

- **Backup and restore, actually executed.** The whole system is one SQLite
  file. Lose it and every customer re-scans a QR code — the worst day this
  project can have, and among the cheapest to prevent. A scripted backup, and a
  restore proven by running against the copy.

- **Rate limiting per API key.** One runaway loop in a caller — including one
  of our own — can exhaust a device's send quota and get the number flagged by
  WhatsApp. The cost of that is not an error page; it is a customer's phone
  number being restricted.

- **Four metrics that say when SQLite stops coping.** Everything else defers
  scaling decisions to "later", and later only works if something tells you it
  has arrived:
  - `SQLITE_BUSY` retries per minute — writers contending
  - delivery queue depth and oldest-pending age — the worker falling behind
  - send latency p95, split by phase — whether the database or WhatsApp is slow
  - devices per pool against capacity — what forces a second process, and with
    it the Postgres and queue-server decisions in
    [ADR-0005](adr/0005-postgres-over-sqlite.md)

### Do when someone outside these projects holds an API key

Both are in [`todo.txt`](../todo.txt) with full context. Neither is urgent while
every tenant is one of ours, and both become urgent the same day that changes,
because they are defences against a tenant rather than against a bug.

- **Killable regex worker** — a rule pattern is tenant-supplied code
- **DNS-pinned HTTP client** — a webhook URL is a tenant-supplied destination

### Deliberately not doing

Recorded so the omissions read as decisions rather than oversights:

| Dropped | Why |
| --- | --- |
| Prometheus/Grafana stack | Structured logs with a correlation id already answer "what happened to this send?". The four metrics above can be a JSON endpoint. |
| OpenTelemetry tracing | Traces earn their keep across process boundaries. There is one process. |
| Chaos engineering | For teams with an on-call rotation to exercise. |
| 24-hour soak | An hour at realistic load tells you nearly as much. Revisit if the density figures are ever load-bearing. |
| Runbooks | For handing to someone who did not build it. |
| Secret encryption at rest | Reconsider the day the database file is backed up somewhere you do not control — which the backup work above makes concrete. |

**Exit criteria:** a restore from backup proven by running against it, a send
quota that cannot be exhausted by one caller, and the four numbers visible.

**Status:** done, plus one thing the review of it caught — three sweeps
(expired idempotency keys, closed rate-limit windows, and sends accepted but
never acknowledged) existed as tested functions that nothing ever called. The
third is the one that mattered: it is the whole answer to the measured
203-second window in which the engine reports a device connected while it
cannot deliver, and without it the API reported success while an OTP silently
never arrived. All three now run on a 30-second loop. `bun run backup` takes a verified snapshot — it refuses to
certify one whose schema does not match the build, which it demonstrated on its
first real run against a stale local database. Sends are limited per *device*
rather than per key, because a number reachable through several bindings shares
one budget and the number is what WhatsApp restricts. `GET /metrics` reports the
four signals with their thresholds, degrading to `databaseReachable: false`
rather than failing — an operator reaching for metrics during a database
incident is precisely who needs it to answer.

---

## Stage 3 — Dashboard

**Goal:** owners self-serve; operators can see the fleet.
**Estimate:** 4–6 weeks. Detail in [07](07-dashboard.md).

- Separate `dashboard/` subproject; React 19 + TanStack + Tailwind v4 +
  shadcn/ui, typed by Eden Treaty
- Project console: environments, API keys, claim-a-number, webhook, deliveries
- Operator console: fleet, pools, bindings matrix, consents, deliveries
- SSE-driven live updates
- `bunwa:full` image tag; `bunwa:api` stays dashboard-free
- Accessibility and performance budgets enforced in CI

**Status: done, and smaller and differently shaped than this list.**
[07](07-dashboard.md) carries the detail. Three things went another way:

The separate subproject was built and then undone. It had its own
`package.json`, lockfile, tsconfig, test runner and copy of Elysia, ran a
second Elysia on a second port, and reached the API through a proxy. The two
Elysias drifted within a day and the proxy pointed at the wrong port. The
console now lives at `src/console/` and is served by the same app, which is
also what made Eden Treaty trivial — the server's `App` type is an import
rather than a published artefact.

TanStack Router, TanStack Query and shadcn/ui are not installed. One route and
five screens is not the size at which they earn their weight.

The operator console does not exist, and neither do environments, API keys,
webhook configuration, rules or logs. What exists is claim-a-number, virtual
devices, deliveries, and conversations — the last of which this list could not
have anticipated, because it only became bunwa's to show in stage 4.

The accessibility and performance budgets are not enforced in CI. They were
never measured, in either layout.

**Exit criteria:** a Grande developer claims a number, completes pairing, and
watches a webhook delivery succeed — without an operator, and without leaving
the console. That path exists in the console; it has not been walked against a
real phone.

---

## Stage 4 — Pivot to Baileys

**Goal:** make Baileys the primary engine and drop the gowa dependency.
**Estimate:** 8–12 weeks. Detail in [ADR-0002](adr/0002-engine-adapter.md),
[ADR-0007](adr/0007-gowa-engine-for-v1.md), [09](09-baileys-option.md),
[11](11-engine-decision.md), [13](13-owning-the-data.md).

This was previously written as *optional*, entered only if gowa became a
bottleneck. It became a decision: gowa was chosen for v1 to get a working
control plane without also writing a WhatsApp client, and that job was done.

**Status: done.** Baileys is the engine. gowa is gone — the adapter, the
measurement harness, the compose stack and the reference clone, about 2,500
lines, deleted rather than kept.

### What the engine abstraction bought

Measured on the merged stage-2 tree before the pivot, not estimated:

- `DeviceEngine` is **seven methods** — `provision`, `startPairing`, `logout`,
  `purge`, `status`, `send`, `subscribe`.
- Code coupling to gowa outside `src/engine/gowa/` was **14 lines** across six
  files: the composition root in `index.ts` (5), `GOWA_BASE_URL` in
  `config/env.ts` (4), a hardcoded `choosePool("gowa", …)` in
  `api/routes/devices.ts` (2), and one line each in `engine/types.ts`,
  `db/schema.ts` and `stores/device-store.ts`. Everything else mentioning gowa
  was a comment citing the stage-0 measurements — and still is.
- The **conformance suite runs against any engine** through a harness, so the
  Baileys adapter inherited eight behavioural guarantees the day it compiled.

Those fourteen lines are the whole evidence for the abstraction. Replacing an
engine cost a directory and a composition root, which is what
[ADR-0002](adr/0002-engine-adapter.md) claimed it would and what makes the
claim worth believing next time.

### Keeping a Baileys change to a few files

Baileys is unofficial and moves quickly, so the requirement was that a breaking
change upstream lands in one place. All four hold:

1. **A single port module** — `src/engine/baileys/socket.ts` — is the only file
   permitted to import from `@whiskeysockets/baileys`.
2. The adapter (`src/engine/baileys/adapter.ts`) depends on that port, never on
   library types. No Baileys type appears in a `DeviceEngine` signature.
3. A CodeRabbit path instruction **and a test** assert rule 1, so an import
   added elsewhere fails rather than being noticed later.
4. The version is pinned exactly — `7.0.0-rc14`, no caret. A release candidate,
   chosen deliberately and against the analysis;
   [ADR-0009](adr/0009-baileys-version-and-isolation.md) records both sides.

### What was planned, and what the plan got wrong

The sequence below is the plan as written, with what happened to each step.

1. **Config-drive the engine kind.** Done, and it went further than planned:
   the pairing route names no engine at all. It asks the registry for any pool
   with capacity, and preference is registration order decided in the
   composition root. `EngineKind` is now `baileys | fake`.
2. **The port module, then the adapter.** Done, at roughly the estimated size.
3. **Session persistence.** Done, and it turned out to be the largest piece of
   the stage rather than a step within it — [13](13-owning-the-data.md) is the
   document it grew into. `useMultiFileAuthState` writes credentials in
   plaintext and puts a recipient's phone number in a filename, which for an
   OTP sender means the recipient list is a directory listing. Credentials are
   now AES-256-GCM encrypted in the same database as everything else, so
   `VACUUM INTO` captures them and the rows together; Signal key ids are stored
   as `sha256(id)`, which works because Baileys only ever looks keys up by
   known id and never enumerates.
4. **Re-run stage 0 against Baileys.** *Not done.* The 203-second blind window
   is a gowa measurement and the ack timeout exists because of it. The timeout
   is still in place, which is the right default — but "Baileys may be better"
   is still an assumption, and it is now the oldest unverified one in the
   project.
5. **Rethink pools.** Partly. `enginePoolId` and `ENGINE_POOL_CAPACITY` still
   bound how many devices a pool takes, but a pool is no longer a process, so
   what the bound protects has changed. See
   [ADR-0003](adr/0003-process-isolation.md), which needs revisiting rather
   than a fresh answer invented here.
6. **Shadow mode, then migrate one internal device, then by cohort.** Not
   reached. There was nothing to migrate — gowa was gone before anything ran on
   it — and a device has since paired directly on Baileys rather than being
   moved onto it. `BAILEYS_ENABLED` defaults to off in place of a rollout: one
   device paired by hand is not a cohort, so a deployment opts in rather than
   being upgraded into it.
7. **Keep the gowa adapter as a failover.** *Reversed.* Two engines is
   insurance only while both are maintained, and nothing was maintaining an
   adapter for a dependency being removed. It was deleted rather than left to
   rot into a failover that would fail. Recorded in
   [ADR-0002](adr/0002-engine-adapter.md).

**Exit criteria:** conformance parity, session state provably surviving restart
and restore-from-backup, stage 0 re-measured, and 30 days of a production cohort
on Baileys with no regression in delivery rate or reconnect latency.

Two of the four are met: conformance parity, and session state surviving
restart and restore.

A real device has now paired, which is what the other two were waiting on — but
neither is met by it. Stage 0 has still not been re-measured against Baileys,
so the 203-second blind window that justifies the ack timeout remains a *gowa*
number ([12](12-stage0-findings.md)); and one device paired by hand is not
thirty days of a production cohort. The blocker moved from "cannot be done" to
"not done", which is progress but not the same as met.

---

## Stage 5 — Features

Ordered by value, not by novelty. Revisit with real usage data — of which there
is still none, which is the argument for not starting any of them yet.

Three things are ahead of every row in this table, because each is a gap
between what the system claims and what it does rather than something it does
not claim at all:

1. **Re-measure the blind window against Baileys.** A device has paired, so
   this is finally possible; it has not been done. The ack timeout, the
   undelivered sweep and the whole "acceptance is not delivery" design rest on
   a number measured against gowa. Everything below assumes traffic, and
   nothing here has carried any.
2. **Send the consent challenge and parse the reply.** A claim against a number
   another project holds answers "the phone holder has been asked to confirm",
   and nobody is asked (§1.3, exit criterion 2).
3. **The three items in [`todo.txt`](../todo.txt)** — the terminable regex
   worker, the DNS-pinned HTTP client, the rule circuit breaker, and the
   per-virtual-device delivery queue the design specifies and the schema does
   not have.

| Feature | Notes |
| --- | --- |
| Message templates with variables | Per project, versioned |
| Scheduled and delayed sends | Naturally durable on the existing queues |
| Conversation state machines | Multi-step flows beyond single-message rules |
| Per-environment analytics | Volume, response time, failure rate |
| Media pipeline | Transcode, thumbnail, virus scan before delivery |
| Multi-region engine pools | Latency and jurisdictional data residency |
| Meta Cloud API engine adapter | The interface already permits it |
| Device warm standby | Second engine pre-provisioned for critical numbers |

---

## Summary

| Stage | Estimated | State | Delivers |
| --- | --- | --- | --- |
| 0 — Understand | 1 wk | done | Knowledge, measurements |
| 1 — Control plane | 6–8 wk | done | **All three objectives** |
| 2 — Hardening | 2–3 days | done | Backup, rate limits, the numbers that say when to scale |
| 3 — Console | 4–6 wk | done | Self-service, for four screens' worth of it |
| 4 — Baileys engine | 8–12 wk | done | Independence, and ownership of the data that comes with it |
| 5 — Features | ongoing | not started | Differentiation |

The estimates are left as they were written rather than replaced with actuals,
because the point of recording them was the *sequence* they justified and that
part held: the control plane arrived before the rewrite, and the rewrite was
then a swap rather than a prerequisite. Stage 4 was written as something you
might rationally decide never to do. It was decided on within days of stage 3
landing, for a reason the estimate could not have contained — not that gowa
became a bottleneck, but that the abstraction had held under two stages of
pressure and the cost of the pivot was therefore knowable.

## Stage 1 completion note

*Recorded 2026-08-23.*

§1.1 through §1.6 are implemented, with one deliberate carve-out: **rule actions
are planned but not executed.** The evaluator decides what a rule would do and
the dry run reports it, but `reply` does not yet send.

That is an ordering decision, not an omission. Executing a reply means sending
a WhatsApp message on a rule match, which needs the per-binding rate limiting,
the reply-rate cap and the rule-level circuit breaker described in
[05](05-events-and-rules.md) — all of which belong with the hardening in stage
2. Shipping the trigger without them would mean a single mis-written rule could
message a customer in a loop bounded only by the depth cap.

What exists and is tested: matching, RE2-only pattern safety with the three
mitigations, loop protection by origin and by depth, per-binding rule storage
scoped to the environment, and a dry run that cannot send because the evaluator
it calls has no way to.

*Amended after stage 4.* Two more carve-outs in §1.3, found by checking this
list against the code rather than against itself:

**The WhatsApp challenge is not sent, and no reply is parsed.** `DeviceStore`
runs the consent state machine — request, grant, deny, lapse, revoke — and
writes the immutable audit log with evidence, and all of it is tested. Nothing
calls `DeviceStore.respond` outside those tests. So exit criterion 2 above is
unmet: a claim against a number another project holds returns 202 saying the
phone holder has been asked to confirm, and no message is sent. This is the one
place where the API states an action it does not take.

**Postgres RLS policies** were never written, and cannot be: [ADR-0005](adr/0005-postgres-over-sqlite.md)
moved the project to SQLite, where the tenant boundary is enforced in the store
layer instead. The line is left in the list above as a record of what the plan
said, not as outstanding work.
