/**
 * Atomicity, verified rather than assumed.
 *
 * A previous commit claimed the consent flows were transactional. They were
 * not: `drizzle.transaction(async …)` on bun-sqlite does not await the
 * callback, so writes either side of an await both survived a rollback. Code
 * that looks transactional and is not is worse than none, because it stops
 * anyone looking.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createDatabase } from "../index";
import { withTransaction } from "../transaction";

function scratch() {
  const database = createDatabase(":memory:");
  database.run(sql`create table t (id integer primary key, v text)`);
  return database;
}

describe("withTransaction", () => {
  test("commits when the callback resolves", async () => {
    const database = scratch();
    await withTransaction(database, async () => {
      database.run(sql`insert into t (v) values ('a')`);
      await Bun.sleep(1);
      database.run(sql`insert into t (v) values ('b')`);
    });
    expect(database.all(sql`select v from t`)).toHaveLength(2);
  });

  test("rolls back writes made either side of an await", async () => {
    // The exact case drizzle's own wrapper failed: both rows survived there.
    const database = scratch();
    await expect(
      withTransaction(database, async () => {
        database.run(sql`insert into t (v) values ('a')`);
        await Bun.sleep(1);
        database.run(sql`insert into t (v) values ('b')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(database.all(sql`select v from t`)).toHaveLength(0);
  });

  test("propagates the original error, not a rollback failure", async () => {
    const database = scratch();
    await expect(
      withTransaction(database, async () => {
        throw new Error("the real problem");
      }),
    ).rejects.toThrow("the real problem");
  });

  test("drizzle's own async transaction does not roll back — the reason this exists", async () => {
    // Pinned so that if a future drizzle release fixes this, the failure tells
    // us the workaround can go rather than leaving it in place forever.
    const database = scratch();
    try {
      await database.transaction(async () => {
        database.run(sql`insert into t (v) values ('a')`);
        await Bun.sleep(1);
        throw new Error("boom");
      });
    } catch {
      /* expected */
    }
    expect(database.all(sql`select v from t`).length).toBeGreaterThan(0);
  });
});
