CREATE TABLE `news_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`link` text NOT NULL,
	`lang` text NOT NULL,
	`source_title` text NOT NULL,
	`source_body` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_translations_link_lang_unique` ON `news_translations` (`link`,`lang`);
