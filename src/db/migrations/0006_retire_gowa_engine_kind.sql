-- `devices.engine_kind` loses the two kinds that no longer exist.
--
-- `0000_full_schema` created the column with a default of 'gowa' and the enum
-- is now 'baileys' | 'fake'. SQLite does not constrain a text column to an
-- enum, so nothing failed at runtime — the schema and its migrations simply
-- stopped agreeing, and a database created from the migrations would carry a
-- default this build no longer accepts.
--
-- Generated rather than hand-written: SQLite cannot alter a column default, so
-- the table is rebuilt and its rows copied, which is what drizzle-kit emits.
--
-- The rows are then fixed too, because leaving them was the same mistake one
-- level down: a column whose enum is baileys|fake holding 'gowa' is a value
-- every read above it is typed against and none of them expect.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`msisdn` text NOT NULL,
	`jid` text,
	`push_name` text,
	`engine_kind` text DEFAULT 'baileys' NOT NULL,
	`engine_pool_id` text,
	`engine_device_id` text,
	`state` text DEFAULT 'unpaired' NOT NULL,
	`state_reason` text,
	`first_paired_at` integer,
	`last_connected_at` integer,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_devices`("id", "msisdn", "jid", "push_name", "engine_kind", "engine_pool_id", "engine_device_id", "state", "state_reason", "first_paired_at", "last_connected_at", "last_seen_at", "created_at", "updated_at") SELECT "id", "msisdn", "jid", "push_name", "engine_kind", "engine_pool_id", "engine_device_id", "state", "state_reason", "first_paired_at", "last_connected_at", "last_seen_at", "created_at", "updated_at" FROM `devices`;--> statement-breakpoint
DROP TABLE `devices`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_msisdn_key` ON `devices` (`msisdn`);--> statement-breakpoint
CREATE INDEX `devices_jid_idx` ON `devices` (`jid`);--> statement-breakpoint
-- Rows that still name an engine this build does not have.
--
-- Reset rather than translated. A row saying 'gowa' describes a session held by
-- a process that is gone, and the credentials went with it — gowa owned the
-- multi-device credentials and bunwa never had a copy. Rewriting the kind to
-- 'baileys' would therefore claim a socket this instance cannot open and a
-- session it cannot resume, and the device would sit reporting connected while
-- nothing could deliver for it. Unpaired is what is actually true; the device
-- pairs again.
--
-- The pool columns go with it: they name a pool that was a separate container.
UPDATE `devices`
SET
  `engine_kind` = 'baileys',
  `state` = 'unpaired',
  `state_reason` = 'engine retired: this device was paired through gowa, which stage 4 removed',
  `engine_pool_id` = NULL,
  `engine_device_id` = NULL,
  `updated_at` = unixepoch() * 1000
WHERE `engine_kind` NOT IN ('baileys', 'fake');
