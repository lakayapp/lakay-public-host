CREATE TABLE `lakay_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`link` text NOT NULL,
	`lang` text NOT NULL,
	`title` text NOT NULL,
	`dek` text NOT NULL,
	`paragraphs` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lakay_articles_link_lang` ON `lakay_articles` (`link`,`lang`);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`pw_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_unique` ON `members` (`email`);
