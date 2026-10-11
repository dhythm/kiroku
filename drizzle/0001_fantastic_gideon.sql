ALTER TABLE `ai_requests` ADD `ip` text NOT NULL;--> statement-breakpoint
CREATE INDEX `ai_day_ip` ON `ai_requests` (`day`,`ip`);