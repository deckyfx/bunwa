# 07 — Dashboard

## Context

gowa's dashboard is not in its repository. `src/infrastructure/uiasset/`
downloads a prebuilt `index.html` from a GitHub release and caches it on disk,
with a SHA-256 and an ETag. So there is nothing to "port" in the literal
sense — this is a greenfield build, which removes the main constraint.

## A separate subproject, and a separate image

The dashboard is **its own subproject** with its own build, its own
`package.json`, and no import path into the control plane. It talks to bunwa
over the same public HTTP API a project would use.

```
bunwa/
├── src/            control plane        → image tag  bunwa:api
└── dashboard/      React SPA            → image tag  bunwa:full  (api + SPA at /app)
```

Two tags from one build. `bunwa:api` contains no dashboard assets at all — for
deployments that only want the API, the SPA is not merely unrouted, it is not
present. The control plane serves `/app/*` static assets only when they exist on
disk, so the same binary runs in both images with no build flag.

Coupling is limited to the generated API types, imported from
`@bunwa/api-types` — a build artefact of the control plane, not a source
dependency. The dashboard can therefore be developed, versioned and released
independently, and a project could replace it entirely with their own.

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
dashboard imports the server's type and gets fully-typed calls with no codegen,
no drift, and a compile error the moment an endpoint changes.

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

## Delivery order

The dashboard is stage 3, but two screens are needed earlier and should be built
during stage 1 as raw, unstyled utilities inside the `api` image's `/dev` route,
removed before release:

1. **Claim a number** — nothing can be tested without a QR on screen
2. **Approve a consent** — the WhatsApp challenge needs a manual fallback while
   the reply parser is being written

Everything else waits for the proper design pass.
