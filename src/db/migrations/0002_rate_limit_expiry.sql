-- Drizzle generates `ADD `expires_at` integer NOT NULL` with no default, which
-- SQLite rejects outright on a table that has rows: "Cannot add a NOT NULL
-- column with default value NULL". Written by hand so the upgrade works on a
-- database that is actually in use.
ALTER TABLE `rate_limits` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfilled rather than left at 0, which would read as "expired" and let the
-- next sweep clear live counters — handing every throttled caller a free
-- window at the moment of the upgrade. Every limit shipped so far uses a
-- 60_000ms window, so this reconstructs the true window end.
UPDATE `rate_limits` SET `expires_at` = `window_start` + 60000;--> statement-breakpoint
CREATE INDEX `rate_limits_expiry_idx` ON `rate_limits` (`expires_at`);
