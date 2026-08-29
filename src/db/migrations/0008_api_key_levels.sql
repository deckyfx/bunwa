-- An API key is a tenant key or an admin key, and only one of them has a tenant.
--
-- `level` defaults to 'tenant' so every existing row keeps exactly the meaning
-- it had: a credential acting inside one environment. Nothing is promoted by
-- this migration — an admin key has to be minted deliberately.
--
-- `environment_id` becomes nullable for one reason: an admin key has no tenant
-- to name. It is not "optional" for a tenant key, which the middleware enforces
-- by refusing a tenant key that has no environment rather than trusting the
-- column alone.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text DEFAULT 'tenant' NOT NULL,
	`environment_id` text,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`label` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("id", "level", "environment_id", "key_hash", "key_prefix", "label", "scopes", "last_used_at", "expires_at", "revoked_at", "created_at", "updated_at") SELECT "id", "level", "environment_id", "key_hash", "key_prefix", "label", "scopes", "last_used_at", "expires_at", "revoked_at", "created_at", "updated_at" FROM `api_keys`;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_key` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_environment_idx` ON `api_keys` (`environment_id`);--> statement-breakpoint
CREATE INDEX `api_keys_prefix_idx` ON `api_keys` (`key_prefix`);