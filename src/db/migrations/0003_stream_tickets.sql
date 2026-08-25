CREATE TABLE `stream_tickets` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`api_key_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stream_tickets_expiry_idx` ON `stream_tickets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `stream_tickets_environment_idx` ON `stream_tickets` (`environment_id`);