# ADR-0002 — Abstract WhatsApp access behind a `DeviceEngine` interface

**Status:** Accepted · 2026-08-22 · Amended 2026-08-27 (the second engine was removed, not kept)

## Context

bunwa needs WhatsApp protocol access. Three ways to get it:

1. Call gowa's HTTP API directly from the business logic
2. Implement the protocol natively with Baileys
3. Define an interface and implement both behind it

Option 1 scatters `gowa` throughout the codebase and makes any future change a
rewrite. Option 2 means starting with the hardest, least-differentiated work and
accepting Baileys' protocol risk immediately — while its 7.x line is still at
release candidate.

## Decision

Define `DeviceEngine` ([03](../03-architecture.md#the-deviceengine-interface)).
Implement `GowaEngine` now, `NativeEngine` later. A single conformance suite runs
against every adapter, written during stage 1 against the gowa adapter.

The interface is constrained to what *both* an HTTP client and an in-process
socket can express. That constraint is a feature: it prevents gowa-shaped
assumptions leaking into the control plane.

Adapters own normalisation. The control plane must never contain
`if (engine === "gowa")`.

## Consequences

**Good**

- The rewrite becomes a per-device, reversible migration
- Conformance parity is a number, not an opinion
- A Meta Cloud API adapter becomes possible later at no extra architectural cost
- Engine-specific bugs are contained in one directory

**Bad**

- The interface is the lowest common denominator; engine-specific capabilities
  need an explicit capability-negotiation escape hatch
- Two implementations means two sets of bugs
- HTTP-to-gowa adds a network hop and its latency to every send

**Rejected alternative — patch gowa directly.** Tempting for lifecycle events
(~100 lines), and worth contributing upstream regardless. But maintaining a fork
of a fast-moving 51k-line Go project is a permanent tax, and it would not solve
tenancy, consent, rules, or durable delivery.

---

## Amendment · 2026-08-27 · one engine, and the interface stays

Stage 4 made Baileys the engine and **deleted the gowa adapter** rather than
keeping it. That contradicts the arrangement this ADR implied and
[ADR-0007](0007-gowa-engine-for-v1.md) stated outright — "the gowa adapter
stays; two working engines is the failover ADR-0002 described, and it costs one
directory."

It does not cost one directory. It costs one directory *that is maintained*.
Two engines is insurance only while both are exercised, and nothing was going to
exercise an adapter for a dependency being removed: it would have gone stale
against the conformance suite, against the schema, and against whatever the
control plane learned next, and the first time anyone reached for it in an
incident they would have found it broken. A failover that has not been run is
not a failover, it is a claim.

**The interface is not withdrawn, and this is the point worth being careful
about.** The evidence for `DeviceEngine` is what the pivot cost: coupling to
gowa outside its own directory was fourteen lines across six files, so replacing
an engine was a directory and a composition root. That is the argument for the
abstraction, and it was only measurable because the abstraction existed. What
changed is the number of implementations, not whether there should be a seam.

Two implementations still exist and both run the conformance suite: the Baileys
adapter, and `FakeEngine` — which is not a stand-in for a missing engine but the
reason the whole control plane can be tested without a phone.

**Consequences of the amendment**

- The "two sets of bugs" cost above no longer applies; nor does the HTTP hop.
- There is no fallback if Baileys regresses. `BAILEYS_ENABLED` defaults to off,
  which is a way of not depending on it yet rather than a way of recovering
  from it.
- Adding a second engine later — the Meta Cloud API adapter in
  [08](../08-roadmap.md) — is the same shape of work the pivot turned out to
  be. That is the property this ADR was buying and it survives.
