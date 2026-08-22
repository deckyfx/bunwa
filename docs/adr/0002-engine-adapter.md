# ADR-0002 — Abstract WhatsApp access behind a `DeviceEngine` interface

**Status:** Accepted · 2026-08-22

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
