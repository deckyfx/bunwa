# ADR-0009 — Baileys 6.7.24, behind a single port module

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

**Pin `6.7.24` exactly**, with no caret. Revisit when 7.0.0 reaches GA, with
the conformance suite as the gate rather than the version number.

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
- The 7.x migration will be a real piece of work rather than a version bump.
  That is the cost of not running a release candidate against OTP traffic, and
  it is the right trade while gowa remains registered as the failover
  ([ADR-0002](0002-engine-adapter.md)).
- `6.7.24` being tagged `legacy` will look alarming to anyone who reads
  package.json without this file. Hence this file.
