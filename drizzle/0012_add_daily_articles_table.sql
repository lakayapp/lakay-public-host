CREATE TABLE `daily_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_url` text NOT NULL,
	`source_name` text NOT NULL,
	`source_title` text NOT NULL,
	`teaser` text NOT NULL,
	`source_text` text NOT NULL,
	`image_url` text,
	`source_published_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_articles_source_url_unique` ON `daily_articles` (`source_url`);
