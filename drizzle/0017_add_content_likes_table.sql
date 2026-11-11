CREATE TABLE `content_likes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`target_id` integer NOT NULL,
	`member_name` text,
	`member_email` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_likes_member_unique` ON `content_likes` (`kind`,`target_id`,`member_email`);
