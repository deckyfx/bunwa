CREATE TABLE `chat_media` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_media_device_idx` ON `chat_media` (`device_id`);--> statement-breakpoint
CREATE INDEX `chat_media_sha_idx` ON `chat_media` (`sha256`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`device_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`direction` text NOT NULL,
	`provider_message_id` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`body` text,
	`media_id` text,
	`status` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `chat_media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_messages_thread_idx` ON `chat_messages` (`thread_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_age_idx` ON `chat_messages` (`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_provider_idx` ON `chat_messages` (`environment_id`,`device_id`,`provider_message_id`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`device_id` text NOT NULL,
	`peer_jid` text NOT NULL,
	`display_name` text,
	`last_message_at` integer,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_threads_env_device_peer_idx` ON `chat_threads` (`environment_id`,`device_id`,`peer_jid`);--> statement-breakpoint
CREATE INDEX `chat_threads_recent_idx` ON `chat_threads` (`environment_id`,`last_message_at`);