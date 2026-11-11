ALTER TABLE `spotlights` ADD COLUMN `likes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `spotlight_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`spotlight_id` integer NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`spotlight_id`) REFERENCES `spotlights`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trivia_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lang` text NOT NULL,
	`q_index` integer NOT NULL,
	`source_q` text NOT NULL,
	`q` text NOT NULL,
	`choices` text NOT NULL,
	`fact` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trivia_translations_lang_q_index_unique` ON `trivia_translations` (`lang`,`q_index`);
