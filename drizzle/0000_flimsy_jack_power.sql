CREATE TABLE `ai_control` (
	`id` integer PRIMARY KEY NOT NULL,
	`blocked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`day` text NOT NULL,
	`units` integer NOT NULL,
	`session_limit` integer NOT NULL,
	`budget` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_day_owner` ON `ai_requests` (`day`,`owner`);--> statement-breakpoint
CREATE INDEX `ai_active` ON `ai_requests` (`active`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text NOT NULL,
	`summary` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notes_owner_updated` ON `notes` (`owner`,`updated_at`);