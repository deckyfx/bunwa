# ADR-0008 — The SSE stream authenticates with short-lived tickets

**Status:** Accepted · 2026-08-25

## Context

[07](../07-dashboard.md) specifies one SSE connection per console, using the
browser's `EventSource`, chosen for auto-reconnection and proxy friendliness.
It does not say how that connection authenticates, and neither does any other
document — the dashboard's auth story was never written down.

`EventSource` cannot send request headers. Every other route in this API is
authenticated by `x-api-key`, so the mechanism the whole system uses is
unavailable to the one endpoint the dashboard depends on most.

This is not a small gap. `src/auth/middleware.ts` records a deliberate decision
that the API key is never logged, "not even a prefix: a log aggregator is a
lower-trust store than the database the hash lives in". Putting the key in a
query string would place it in access logs, proxy logs, browser history and
`Referer` headers — reversing that decision by accident, in the course of adding
a feature.

## Decision

A two-step handshake.

1. `POST /v1/events/ticket`, authenticated normally by `x-api-key`, returns an
   opaque single-use ticket with a short TTL.
2. `GET /v1/events/stream?ticket=…` accepts that ticket, resolves it to the same
   environment the key belonged to, and consumes it.

The ticket is bound to one environment, is valid once, and expires in seconds
rather than hours.

## Why this rather than the alternatives

**Key in the query string** is the cheapest to build and was rejected on the
grounds above: it contradicts an existing, reasoned security decision, and it
does so somewhere nobody would think to look for it later.

**`fetch` with a `ReadableStream`** can set headers, so it needs no new concept
at all. It was rejected because reconnection, backoff and `Last-Event-ID`
resumption then become ours to write and to get right — and those are precisely
the properties [07](../07-dashboard.md) chose `EventSource` for. Trading a
documented library behaviour for hand-rolled code is the wrong direction for a
connection that must survive a laptop lid closing.

**A cookie session** is the honest long-term answer for a browser application
and remains open. It was not chosen now because it is a whole subsystem — login,
logout, CSRF, session storage, expiry — and the dashboard does not yet exist to
justify it. A ticket endpoint is small enough to delete if sessions arrive.

## Consequences

- A ticket in an access log is worthless within its TTL, and worthless
  immediately after use. The exposure a query parameter creates is bounded
  instead of permanent.
- One more endpoint, and a store for tickets. It is the same shape as the
  rate-limit table: keyed, expiring, swept by housekeeping.
- Tickets must be single-use in fact, not by intention. A ticket that can be
  replayed is a bearer token with a short life, which is a weaker thing than
  what this claims to be — so consumption is a conditional delete whose result
  decides the answer, not a read followed by a write.
- The dashboard needs the key once per session to mint tickets. Where the
  browser keeps that key is a separate question, and is the reason the cookie
  session stays on the table.
