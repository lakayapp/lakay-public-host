ALTER TABLE `spotlights` ADD COLUMN `image_keys` text;
--> statement-breakpoint
ALTER TABLE `spotlights` ADD COLUMN `video_blob_key` text;
--> statement-breakpoint
CREATE TABLE `text_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_text` text NOT NULL,
	`lang` text NOT NULL,
	`translated` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_translations_source_lang_unique` ON `text_translations` (`source_text`,`lang`);
