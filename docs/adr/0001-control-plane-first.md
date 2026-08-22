# ADR-0001 — Build the control plane before rewriting the engine

**Status:** Accepted · 2026-08-22

## Context

The original plan sequenced a Go → Bun rewrite of gowa as stage 2, before the
multi-tenancy work that motivated the project. gowa is 51k lines of Go; roughly
30k after excluding Chatwoot and chat storage, which are out of scope.

The three problems that justify the project — undelivered lifecycle events, no
trigger engine, no project↔device many-to-many — are all **control-plane**
problems. None of them is caused by gowa being written in Go, and none is solved
by it being written in TypeScript.

## Decision

Build the control plane first, over gowa as an unmodified dependency. Defer the
native engine to an optional later stage, entered only against explicit criteria
([08](../08-roadmap.md#stage-4--native-bun-engine-optional)).

## Consequences

**Good**

- Roughly three months to a working product instead of roughly six
- Every stage ships something usable
- The rewrite, when attempted, has a reference implementation and a conformance
  suite to be measured against
- whatsmeow's release cadence is retained during the highest-risk period
- The rewrite can be abandoned without wasting the project

**Bad**

- Two runtimes in production (Bun + Go) for the foreseeable future
- A dependency on an upstream project whose roadmap you do not control
- The adapter layer is real work that a monolithic rewrite would not need
- Some gowa behaviour must be worked around rather than fixed at source

**Accepted risk:** if gowa is abandoned upstream, stage 4 becomes mandatory
rather than optional. Mitigated by the adapter existing from day one, which is
exactly what makes that transition survivable.
