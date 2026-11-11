ALTER TABLE `owner_posts` ADD COLUMN `author_name` text;
--> statement-breakpoint
ALTER TABLE `owner_posts` ADD COLUMN `author_email` text;
--> statement-breakpoint
ALTER TABLE `daily_articles` ADD COLUMN `title` text;
--> statement-breakpoint
ALTER TABLE `daily_articles` ADD COLUMN `body` text;
