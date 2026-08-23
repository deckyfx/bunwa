CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
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
CREATE UNIQUE INDEX `api_keys_hash_key` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_environment_idx` ON `api_keys` (`environment_id`);--> statement-breakpoint
CREATE INDEX `api_keys_prefix_idx` ON `api_keys` (`key_prefix`);--> statement-breakpoint
CREATE TABLE `consent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`consent_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`channel` text NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`consent_id`) REFERENCES `device_consents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consent_events_consent_idx` ON `consent_events` (`consent_id`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_due_idx` ON `deliveries` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `deliveries_environment_idx` ON `deliveries` (`environment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_event_environment_key` ON `deliveries` (`event_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`status_code` integer,
	`error` text,
	`duration_ms` integer NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_attempts_delivery_idx` ON `delivery_attempts` (`delivery_id`);--> statement-breakpoint
CREATE TABLE `device_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by_environment_id` text,
	`challenge_token` text NOT NULL,
	`challenge_sent_at` integer,
	`responded_at` integer,
	`response_channel` text,
	`evidence` text DEFAULT '{}' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_consents_device_project_key` ON `device_consents` (`device_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`msisdn` text NOT NULL,
	`jid` text,
	`push_name` text,
	`engine_kind` text DEFAULT 'gowa' NOT NULL,
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
CREATE UNIQUE INDEX `devices_msisdn_key` ON `devices` (`msisdn`);--> statement-breakpoint
CREATE INDEX `devices_jid_idx` ON `devices` (`jid`);--> statement-breakpoint
CREATE TABLE `environment_webhooks` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`event_filter` text,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`circuit_state` text DEFAULT 'closed' NOT NULL,
	`circuit_opened_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text DEFAULT 'test' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_project_slug_key` ON `environments` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text NOT NULL,
	`environment_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`response` text,
	`status_code` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`environment_id`, `key`),
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idempotency_created_idx` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `outbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`virtual_device_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`engine_message_id` text NOT NULL,
	`type` text NOT NULL,
	`recipient` text NOT NULL,
	`state` text DEFAULT 'accepted' NOT NULL,
	`accepted_at` integer NOT NULL,
	`acked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`virtual_device_id`) REFERENCES `virtual_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`virtual_device_id`,`environment_id`) REFERENCES `virtual_devices`(`id`,`environment_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outbound_engine_message_idx` ON `outbound_messages` (`engine_message_id`);--> statement-breakpoint
CREATE INDEX `outbound_environment_idx` ON `outbound_messages` (`environment_id`);--> statement-breakpoint
CREATE INDEX `outbound_state_accepted_idx` ON `outbound_messages` (`state`,`accepted_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_key` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`virtual_device_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`stop_on_match` integer DEFAULT false NOT NULL,
	`match` text NOT NULL,
	`actions` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`disabled_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`virtual_device_id`) REFERENCES `virtual_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`virtual_device_id`,`environment_id`) REFERENCES `virtual_devices`(`id`,`environment_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rules_binding_name_key` ON `rules` (`virtual_device_id`,`name`);--> statement-breakpoint
CREATE INDEX `rules_binding_priority_idx` ON `rules` (`virtual_device_id`,`priority`);--> statement-breakpoint
CREATE TABLE `virtual_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`device_id` text NOT NULL,
	`alias` text NOT NULL,
	`status` text DEFAULT 'pending_consent' NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`jid_allowlist` text,
	`jid_denylist` text DEFAULT '[]' NOT NULL,
	`activated_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_devices_environment_device_key` ON `virtual_devices` (`environment_id`,`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_devices_id_environment_key` ON `virtual_devices` (`id`,`environment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_devices_environment_alias_key` ON `virtual_devices` (`environment_id`,`alias`);--> statement-breakpoint
CREATE INDEX `virtual_devices_device_idx` ON `virtual_devices` (`device_id`);