-- Instance settings: one row per key, values as text.
--
-- Separate from the devices rebuild it originally shipped beside. That rebuild
-- retired the `gowa` and `native` engine kinds and landed first, on its own, in
-- 0006 — so what is left here is the table this change is actually about. Two
-- unrelated schema changes in one migration is how that rebuild came to be
-- written twice and nearly applied twice.

CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
