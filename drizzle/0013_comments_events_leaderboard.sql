CREATE TABLE `news_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`link` text NOT NULL,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`city` text NOT NULL,
	`venue` text,
	`event_date` text NOT NULL,
	`time_label` text,
	`details` text NOT NULL,
	`link` text,
	`added_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_rsvps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trivia_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`points` integer NOT NULL,
	`chapters_done` integer NOT NULL,
	`week_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
