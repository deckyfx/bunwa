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
- Redis-backed per-virtual-device delivery queues, retry, backoff, DLQ
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

**Goal:** something you would put a customer's number on.
**Estimate:** 3–4 weeks.

- Prometheus metrics per device, environment and virtual device
- OpenTelemetry tracing across control plane → adapter → engine
- Load test: 100 devices, 50 msg/s, sustained 24 h
- Chaos: kill engines, kill Redis, blackhole webhook targets, fill disks
- Backup and restore drill, actually executed
- Secret handling: encryption at rest for webhook secrets and engine credentials
- Rate limiting at the edge
- Runbooks: device stuck, pool wedged, DLQ growing, consent dispute
- Security review: tenant isolation, regex DoS, SSRF on webhook URLs, key handling

**SSRF deserves naming:** projects supply webhook URLs. Without validation,
`http://169.254.169.254/` turns your webhook sender into a cloud-metadata
exfiltration tool. Allowlist schemes, block private ranges, resolve-then-pin.

**Exit criteria:** 24 h soak at target load with zero event loss, and a chaos
run where every failure mode has a runbook that a person other than the author
can follow.

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
| 2 — Hardening | 3–4 wk | 10–13 wk | Production readiness |
| 3 — Dashboard | 4–6 wk | 14–19 wk | Self-service |
| 4 — Native engine | 8–12 wk | 22–31 wk | *Optional* independence |
| 5 — Features | ongoing | — | Differentiation |

Roughly **three months to the thing you actually need**, against roughly six
before the original sequence reached the same point — and stage 4 becomes
something you may rationally decide never to do.
