CREATE TABLE `riddles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`riddle` text NOT NULL,
	`answer` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `riddle_answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`riddle_id` integer NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`riddle_id`) REFERENCES `riddles`(`id`) ON UPDATE no action ON DELETE no action
);
