# ADR-0005 — SQLite now, Postgres when a second process needs the data

**Status:** Accepted · 2026-08-22 · **Amended 2026-08-23** — the original
decision was Postgres from the start; SQLite is now the stage 1 target.

## Context

gowa defaults to SQLite and it works well for it: one process, owning its own
devices, no concurrent writers.

The original version of this ADR chose Postgres immediately, reasoning that the
control plane, several engine pools and a set of delivery workers all need
consistent concurrent access to the same state.

That reasoning holds for the *end state* and not for stage 1, where none of
those processes exists yet. The costs of deciding early turned out to be real:

- **Nothing could be tested against a real database.** The migration
  verification logic — the ordered-prefix comparison that took eight documented
  traps to get right — was pinned only by synthetic rows, because standing up
  Postgres was a prerequisite nobody had met. Switching to SQLite immediately
  produced 8 integration tests that apply real migrations, assert the tracking
  table's contents, and exercise divergence and rollback detection.
- **Every contributor needed a server before the first line ran.**
- Bun ships a SQLite driver, so there is no dependency at all.

## Decision

**SQLite for development and stage 1**, at `./data/db/bunwa.sqlite`, through
Bun's built-in driver. `DATABASE_PATH` configures it; `:memory:` and `file:`
URLs are accepted, and a `postgres://` value is rejected rather than silently
creating a file named after the connection string.

**Postgres when a second process needs the data.** The trigger is concrete: the
moment delivery workers or engine supervisors run outside the API process, a
single-writer database becomes a bottleneck and a single point of failure.

The schema is written to keep that move mechanical:

| Choice | Reason |
| --- | --- |
| Timestamps as epoch milliseconds | Same representation either side |
| JSON stored as text, typed in Drizzle | No dependency on a `jsonb` column type |
| String ids defaulted from `crypto.randomUUID()` | Not SQLite `rowid`, which does not port |
| Enums as constrained text | SQLite has no enum type; Postgres accepts text |
| No SQLite-only functions in the schema | Only `unixepoch()` in a default, trivially swapped |

Connection PRAGMAs are set explicitly: WAL so readers proceed during a write,
`foreign_keys = ON` because SQLite disables them by default and the schema
relies on cascades, and a busy timeout so a concurrent write waits rather than
failing with `SQLITE_BUSY`.

## Consequences

**Good**

- No server, no container, no setup — `bun run dev` creates the database
- Tests run against a real database, which is how the migration logic came to
  have integration coverage at all
- A single-file database is trivially backed up, copied and inspected
- The whole control plane can still ship as one binary plus one file

**Bad**

- **Row-level security is unavailable**, so the second isolation layer in
  [04](../04-data-model.md) is deferred. Repository-level scoping and the
  fan-out direction remain, but the defence in depth is thinner until the move.
  This is the real cost of the amendment and should be stated plainly whenever
  tenancy work is reviewed.
- One writer. Fine while one process owns the data; a ceiling the moment that
  stops being true.
- No `LISTEN`/`NOTIFY`, so cross-process invalidation needs another mechanism
- The port is mechanical but not free: schema, migrations and any raw SQL
  change dialect together

**Rejected alternative — support both from the start.** Drizzle schemas are
dialect-specific, so this means two schema files and two migration histories
kept in step by hand. That is a permanent tax paid to defer a decision that is
cheap to make later.
