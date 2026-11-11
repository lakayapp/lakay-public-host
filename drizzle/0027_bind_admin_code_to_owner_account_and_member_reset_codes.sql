ALTER TABLE `admin_access` ADD COLUMN `owner_email` text;
--> statement-breakpoint
ALTER TABLE `members` ADD COLUMN `reset_hash` text;
--> statement-breakpoint
ALTER TABLE `members` ADD COLUMN `reset_expires` integer;
