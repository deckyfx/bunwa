# ADR-0009 — Baileys 7.0.0-rc14, behind a single port module

**Status:** Accepted · 2026-08-25 · Implements the abstraction requirement in
[08 stage 4](../08-roadmap.md)

## Context

Stage 4 makes Baileys the primary engine. Two questions had to be answered
before any adapter code existed: which version, and how to stop an unofficial,
fast-moving library from spreading through the codebase.

### Version

At the time of writing npm offers two lines:

| Tag | Version | Published |
| --- | --- | --- |
| `latest` | `7.0.0-rc14` | 2026-07-29 |
| `legacy` | `6.7.24` | 2026-07-29 |

The `legacy` tag reads like abandonment and is not: both lines shipped on the
same day, so 6.x is still receiving fixes alongside the 7.x candidates. 7.0.0
is fourteen release candidates in and not yet GA.

The primary use case is OTP ([ADR-0007](0007-gowa-engine-for-v1.md)) — a late
or missing message is a failed login, per user, at the moment of highest
intent. That is the least forgiving traffic there is, and it is the wrong place
to run a release candidate.

## Decision

**Pin `7.0.0-rc14` exactly**, with no caret.

The owner chose the current line over the stable one, knowing it is a release
candidate. Recorded plainly because the reasoning above argues the other way
and the next reader deserves to see both: the risk is that a defect in an RC
reaches OTP traffic, where a late message is a failed login at the moment of
highest intent.

What makes it defensible rather than reckless:

- **gowa stays registered.** ADR-0002 keeps it as the failover, and stage 4
  does not remove it. A Baileys regression is a pool that stops being chosen,
  not an outage.
- **The pin is exact.** An RC that moves under us is the actual danger; a
  chosen RC that stays put is a known quantity.
- **The conformance suite is the gate.** An upgrade — including to GA — either
  passes the eight behavioural guarantees or it does not.
- **Shadow mode comes before traffic.** No customer message goes through
  Baileys until it has run alongside gowa with output diffed.

Measured at the point of the switch, so the cost of being wrong is known
rather than assumed: moving 6.7.24 → 7.0.0-rc14 changed no application code
at all. Typecheck passed, all twelve port tests passed, every export used is
present, and all nine `DisconnectReason` codes kept their numbers. That is
the port module doing its job — and it means moving *back* is equally cheap
if the RC disappoints.

**One file imports the library.** `src/engine/baileys/socket.ts` is the only
module permitted to `import` from `@whiskeysockets/baileys`. It exposes the
narrow surface bunwa needs and nothing else.

- The adapter depends on that port, never on library types.
- No Baileys type appears in a `DeviceEngine` signature. That is what makes the
  engine replaceable at all — the moment one leaks into the interface, every
  other engine has to satisfy a Baileys-shaped contract.
- A test asserts the import rule, so a violation fails a run rather than being
  noticed in review. A CodeRabbit path instruction says the same thing for
  human-facing review.

## Consequences

- A breaking upstream change lands in one file, which is the whole point.
- Pinning means security and protocol fixes are a deliberate action rather than
  an install-time surprise. The conformance suite is what makes that action
  cheap: an upgrade either passes the eight behavioural guarantees or it does
  not.
- Running an RC means upstream defects arrive before anyone else has found
  them. The mitigation is not optimism: it is that gowa keeps serving traffic
  until Baileys has earned it.
- Revisit at 7.0.0 GA — a version bump, not a migration, on current evidence.
- Anyone comparing this file's Context to its Decision will see they disagree.
  That is deliberate. The analysis said 6.7.24; the owner chose the edge; both
  are written down so the trade is visible rather than rediscovered.
