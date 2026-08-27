CREATE TABLE `device_credentials` (
	`device_id` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `device_signal_keys` (
	`device_id` text NOT NULL,
	`key_type` text NOT NULL,
	`key_hash` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `key_type`, `key_hash`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_signal_keys_device_idx` ON `device_signal_keys` (`device_id`);