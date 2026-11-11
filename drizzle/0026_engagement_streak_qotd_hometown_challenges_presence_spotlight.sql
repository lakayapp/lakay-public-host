ALTER TABLE `members` ADD COLUMN `hometown` text;
--> statement-breakpoint
CREATE TABLE `daily_answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_key` text NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `daily_answers_day_key_idx` ON `daily_answers` (`day_key`);
--> statement-breakpoint
CREATE TABLE `trivia_challenges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`chapter_n` integer NOT NULL,
	`challenger_name` text NOT NULL,
	`challenger_email` text NOT NULL,
	`challenger_score` integer,
	`friend_name` text,
	`friend_email` text,
	`friend_score` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trivia_challenges_code_unique` ON `trivia_challenges` (`code`);
--> statement-breakpoint
CREATE TABLE `presence` (
	`session_id` text PRIMARY KEY NOT NULL,
	`member_email` text,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `member_spotlight` (
	`id` integer PRIMARY KEY NOT NULL,
	`member_name` text NOT NULL,
	`member_email` text NOT NULL,
	`hometown` text,
	`updated_at` integer NOT NULL
);
