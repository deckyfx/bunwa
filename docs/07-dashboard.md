# 07 — Console

> **Revised after stage 4.** The separate-subproject arrangement below was
> built, run, and then undone; the section that described it now describes what
> replaced it and why. Everything from "Two applications, not one" onwards is
> the original plan, annotated where the build diverged from it. The document
> is titled "console" rather than "dashboard" because that is what the code and
> the route call it.

## Context

gowa's dashboard is not in its repository. `src/infrastructure/uiasset/`
downloads a prebuilt `index.html` from a GitHub release and caches it on disk,
with a SHA-256 and an ETag. So there was nothing to "port" in the literal
sense — this was a greenfield build, which removed the main constraint.

## One project, one app, two entry points

This section originally specified the console as **its own subproject** with its
own `package.json`, lockfile, tsconfig, test runner and copy of Elysia, running
a second Elysia on a second port and reaching the API through a `/v1` proxy.
That was built and then reversed, because separation between two halves written
by the same person on the same day is upkeep rather than insulation. Concretely:
the two copies of Elysia drifted within a day, the proxy silently pointed at the
wrong port, CI failed on a missing `react` because the root install had no
reason to descend into a subproject it did not know about, and a bare `bun test`
skipped the console suite entirely while reporting success.

The console now lives at `src/console/`, inside the one project, with one
`package.json`, one lockfile, one tsconfig and one test runner. It is served at
`/app` by **the same Elysia app** that answers its API calls, through a plugin
(`src/api/console-plugin.ts`) that hands Bun's HTML import to a route and lets
Elysia's own `listen()` do the bundling, script injection and hot reload.

```
bunwa/
├── src/               control plane
│   └── console/       React SPA, served at /app by the same app
├── src/index-console.ts    the API with the console mounted
└── src/index-headless.ts   the API alone
```

The two entry points differ by one argument. `index-console.ts` imports the
HTML and passes it to `main()`; `index-headless.ts` does not import it at all,
which is what keeps React out of a headless build — a runtime switch would ship
the thing it exists to exclude. `/app` still answers in a headless build, with a
404 that says the console is not in this build, because an operator who expected
it should learn that from the route rather than from a bare 404 that could mean
anything.

One origin is what makes the coupling question disappear. The original answer
was a generated `@bunwa/api-types` package, a build artefact of the control
plane. That is no longer necessary: the console imports the server's exported
`App` type directly and Eden Treaty types every call from it, so a route that
changes signature is a compile error rather than a 400 found in a browser. The
cost of the earlier arrangement was paid before it was fixed — a hand-written
`Whoami` and `VirtualDevice` were both wrong, and the page rendered
"undefined / undefined" against a live API, and a hand-written `attempts` and
`occurredAt` were wrong in the same way in the commit after that.

The server exports two app types rather than one, `HeadlessApp` and
`ConsoleApp`, built by two functions, with `App` aliased to the latter. The
tempting shape is `treaty<HeadlessApp | ConsoleApp>`, and it is wrong: a union
narrows to what both halves share, so it would silently drop routes instead of
describing them. The console knows which server it is talking to, because it is
served by it.

What is genuinely lost is independent release: the console versions and ships
with the API. Against a proxy that pointed at the wrong port and two Elysias
that disagreed, that is a trade worth making, and it can be reversed the day
someone other than us wants to ship their own console — the API it talks to is
still the same public one a project would use.

## Two applications, not one

The audiences have almost nothing in common, and merging them produces a UI that
serves neither.

| | **Project console** | **Operator console** |
| --- | --- | --- |
| Who | A developer at Grande | You |
| Cares about | Environments, API keys, virtual devices, webhook deliveries | Fleet health, engine pools, consent disputes |
| Frequency | During integration, then rarely | Daily |
| Device | Desktop | Desktop |
| Scope | One project's environments | Everything |

Note what is **not** here: an owner console. Devices are system-owned, and the
phone holder is not a bunwa user. Their entire interface is the WhatsApp
challenge message and the unlink button on their own phone — which is the right
amount of interface for someone who never agreed to have an account with you.

Ship them as one codebase with two route trees and two navigation shells, not as
one dashboard with role-conditional buttons scattered through it.

**Built so far: the project console only, and not all of it.** The operator
console does not exist. Nothing about the split has been decided against — it is
that a second route tree with no screens in it is a shell, and routing was left
until there was a second thing to route to.

## Stack

| Concern | Choice | Rationale |
| --- | --- | --- |
| Framework | React 19 | Ecosystem, and it is what the brief asks for |
| Build | Bun's native bundler | Already present; no separate toolchain |
| Routing | TanStack Router | Type-safe routes, first-class search-param state |
| Server state | TanStack Query | Caching, invalidation, and it pairs naturally with SSE |
| Realtime | **SSE**, `EventSource` | One-way, proxy-friendly, auto-reconnecting. There is no client→server realtime requirement, so WebSocket buys nothing. |
| Styling | Tailwind v4 | CSS-first config, no JS config file |
| Components | shadcn/ui | Copy-in, own the code, no vendor lock |
| Forms | React Hook Form + TypeBox | Same schemas as the API |
| Charts | Recharts | Sufficient for the handful of charts needed |
| Types | Eden Treaty | End-to-end types straight from the Elysia server — no client generation step |

Eden Treaty is the reason to have chosen Elysia in [03](03-architecture.md): the
console imports the server's `App` type and gets fully-typed calls with no
codegen, no drift, and a compile error the moment an endpoint changes. That
became simpler than planned once the console moved into the same project — the
type is an import rather than a published artefact.

Of that table, React 19, Bun's bundler, Tailwind v4, SSE and Eden Treaty are in
use. TanStack Router, TanStack Query, shadcn/ui, React Hook Form and Recharts
are not installed. Each was chosen for a problem the console has not reached:
there is one route, no charts, and forms with one or two fields. They stay
listed as the intended answers rather than being deleted, because the reasoning
does not expire — but four screens is not the size at which they earn their
weight.

Server state is **zustand** stores under `src/console/store/`, one per subject,
each holding the Eden client and the guards that go with it. That was not a
preference for zustand over TanStack Query so much as the smallest thing that
fixed a real problem: the state started in `App`'s `useState` and was passed
down, so every screen took an `apiKey` prop and each had written its own version
of the same in-flight and stale-response guards — which is how a stale key
reached a screen that had already been told to use a different one.

## Project console

| Screen | Purpose |
| --- | --- |
| **Environments** | Cards for development / staging / production; status, device count, today's volume |
| **API keys** | Create, label, revoke. Plaintext shown once, with a copy affordance and a warning. |
| **Virtual devices** | Per environment: alias, number, state, binding status, last activity |
| **Claim a number** | The `POST /v1/devices/claim` flow as a UI — enter number, then QR / pairing code / "awaiting confirmation" |
| **Webhook** | URL, secret, event filter, and a **test-fire** button |
| **Deliveries** | Every attempt, status code, response body, replay from the DLQ |
| **Rules** | Editor plus the dry-run tester |
| **Logs** | Recent sends and inbound messages, filtered to this environment |

Four of those exist: **claim a number**, **virtual devices**, **deliveries**,
and one this table never anticipated — **conversations**, a thread list and
message view with a composer, which exists because stage 4 made bunwa the system
of record for history ([13](13-owning-the-data.md)). Environments, API keys,
webhook configuration, rules and logs are still API-only.

### The claim screen

The screen a Grande developer meets first, and the one that has to make three
quite different outcomes feel like one flow:

```
┌──────────────────────────────────────────────────┐
│  Claim a number            production · grande   │
│                                                  │
│  Phone number   [ +62 812-3456-7890        ]     │
│  Alias          [ otp-sender               ]     │
│                                                  │
│  ──────────────── outcome ───────────────────    │
│                                                  │
│  ○ New number                                    │
│      ▓▓░▓░▓▓  scan this, or use code  A1B2-C3D4  │
│                                                  │
│  ○ Already yours                                 │
│      ✓ Active. Nothing to do.                    │
│                                                  │
│  ○ Used by another project                       │
│      ⏳ We messaged +62 812-3456-7890 asking      │
│         them to confirm. Waiting for a reply.    │
│                                                  │
└──────────────────────────────────────────────────┘
```

The first state arrives in the claim response itself, since the QR is withheld
from the stream (see below). The other two transition over SSE rather than
reloading. The third state is the one to get right — the developer needs to
understand that the delay is a human on a phone, not a system fault.

### The WhatsApp challenge

The message the phone holder receives is the real consent UI, and it is six
lines of text. It deserves as much care as any screen:

```
Grande would like to send messages from this WhatsApp number.

You already use this number with another service through us.
If you approve, Grande will be able to send and receive
messages from this number.

Reply YES to approve, or NO to decline. This request expires
in 24 hours.
```

Name the project the way the customer knows it, say plainly what it can do, and
make declining as easy as approving.

## Operator console

| Screen | Purpose |
| --- | --- |
| **Fleet** | Every device system-wide, filterable by state, project, engine. Bulk reconnect. |
| **Device detail** | State machine history, raw engine status, every binding, migrate between pools |
| **Bindings matrix** | Environments down one axis, devices across the other |
| **Consents** | Per (device, project): status, challenge sent, reply evidence, revoke |
| **Engine pools** | Per pool: kind, device count, memory, uptime, restart count |
| **Projects** | Projects, environments, keys, quotas, usage |
| **Deliveries** | Failed and dead-lettered webhooks across all environments, with replay |
| **Events** | Live tail with filters |

The **bindings matrix** is what makes the model legible, and it is how you
answer "what breaks if this number goes offline?" at a glance. The **consents**
screen is what you open when a customer disputes having agreed — it shows their
actual reply and its message id.

## Realtime design

One SSE connection per console, multiplexed by event type. Not one per widget.
The claim flow uses the same stream — a QR refresh is a `device.qr` event like
any other.

```ts
// Single subscription; TanStack Query cache updated in place.
const es = new EventSource("/v1/events/stream?types=device.*,link.*");
es.addEventListener("device.connected", (e) => {
  queryClient.setQueryData(["device", id], patch);
});
```

Rules that follow from experience with this pattern:

- **Optimistic UI for actions, SSE for truth.** Show the intent immediately;
  reconcile when the event lands.
- **Never poll alongside SSE.** Pick one per data source, or debug ghosts.
- **Show connection state.** A silently dead `EventSource` that shows stale data
  as if live is worse than an error banner.
- **QR does not come over the stream.** This document originally said it was
  "a `device.qr` event like any other". The implementation deliberately
  disagrees, and is right to: `handleEngineEvent` returns before fan-out for
  `device.qr` and `device.pair_code`, because a QR is a credential anyone who
  sees it can scan to take over the account, and fanning it out would hand it
  to every other project sharing that phone. It is returned synchronously to
  the caller that started pairing. A console whose QR expires claims again
  rather than waiting for an event that never arrives.

## Accessibility and performance budgets

Non-negotiable, per the operating standards:

| Metric | Budget |
| --- | --- |
| WCAG | 2.1 AA |
| LCP | < 2.5 s |
| Initial JS | < 200 KB gzipped |
| Route chunk | < 50 KB gzipped |
| Fleet table | Virtualised beyond 100 rows |

Both consoles are developer- and operator-facing, so the mobile constraint is
weaker than it would be for a customer-facing consent page — but the fleet and
deliveries tables will hold thousands of rows, which is where the virtualisation
budget earns its place.

**None of these is measured.** [08](08-roadmap.md) listed them as enforced in
CI and they are not, in either project layout. They are a stated intention with
no gate behind it, which is worth saying plainly rather than leaving the table
to imply otherwise.

## Delivery order

The plan was that two screens — claim a number, and approve a consent — would be
needed before stage 3 and should be built during stage 1 as unstyled utilities
behind a `/dev` route, removed before release.

That is not what happened. There was no `/dev` route and nothing was thrown
away: claim-a-number was built once, as the first real screen of the project
console, and it is still the first thing a developer meets — the plan was right
that the QR screen is what makes anything else testable.

The consent fallback was not built, and neither was the thing it was a fallback
for. `DeviceStore` runs the consent state machine and records the audit trail,
but no code sends the WhatsApp challenge and nothing parses a reply into
`DeviceStore.respond`. A claim against a number another project holds returns
202 with "the phone holder has been asked to confirm", and nobody has been
asked. Until that loop exists, the manual approval screen is not a fallback but
the only way to complete the flow, so it moves from "skipped" back to
"outstanding".
