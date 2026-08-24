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
- [ ] Run gowa locally in Docker; pair a real device
- [ ] Measure memory and file descriptors per connected device (open question 2)
- [ ] Measure how long whatsmeow takes to notice a dropped socket (open question 3)
- [ ] Verify `/ws` broadcast behaviour with two devices, one logging out
- [ ] Verify `POST /devices/{id}/webhook` semantics: replace or append?

**Exit criteria:** a device paired to a local gowa, receiving webhooks, and a
written measurement of per-device cost. Those numbers set the deployment
topology in [03](03-architecture.md) and cannot be guessed.

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

**Exit criteria:** a Grande developer claims a number, completes pairing, and
watches a webhook delivery succeed — without an operator, and without leaving
the console. Both image tags build and run from one CI pipeline.

---

## Stage 4 — Native Bun engine *(optional)*

**Goal:** remove the gowa dependency — if, and only if, it is worth it.
**Estimate:** 8–12 weeks. Detail in [ADR-0002](adr/0002-engine-adapter.md).

Enter this stage only when at least one is true
([11](11-engine-decision.md)):

- gowa's release cadence has become a bottleneck on a bug you have reported
- Operating a second language runtime is a measurable operational cost
- A required capability is unreachable through gowa's API
- Per-device resource cost via gowa is demonstrably limiting density
- You want the two-engine failover: a WhatsApp change that breaks one library is
  survivable by migrating devices to the other

If none holds, **do not start it.** "It would be nicer if it were all
TypeScript" is a preference, not a business case, and this document exists partly
to make that distinction hard to blur later.

When it does start:

1. Baileys adapter implementing `DeviceEngine` — ~2,000–2,500 lines under the
   v1 scope ([11](11-engine-decision.md))
2. **Run the stage-1 conformance suite** — the pass rate is the readiness metric
3. Shadow mode: native engine receives events, output diffed against gowa, no
   traffic served
4. Migrate one internal device via `POST /admin/v1/devices/{id}/migrate`
5. Migrate by cohort, with rollback at every step
6. Keep the gowa adapter permanently as a fallback — it is cheap insurance
   against a Baileys regression

**Exit criteria:** conformance parity, 30 days of a production cohort on native
with no regression in delivery rate or reconnect latency.

---

## Stage 5 — Features

Ordered by value, not by novelty. Revisit after stage 3 with real usage data.

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

| Stage | Duration | Cumulative | Delivers |
| --- | --- | --- | --- |
| 0 — Understand | 1 wk | 1 wk | Knowledge, measurements |
| 1 — Control plane | 6–8 wk | 7–9 wk | **All three objectives** |
| 2 — Hardening | 2–3 days | 7–9 wk | Backup, rate limits, the numbers that say when to scale |
| 3 — Dashboard | 4–6 wk | 11–15 wk | Self-service |
| 4 — Native engine | 8–12 wk | 19–27 wk | *Optional* independence |
| 5 — Features | ongoing | — | Differentiation |

Roughly **three months to the thing you actually need**, against roughly six
before the original sequence reached the same point — and stage 4 becomes
something you may rationally decide never to do.

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
