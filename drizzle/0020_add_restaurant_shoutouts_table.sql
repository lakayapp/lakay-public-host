CREATE TABLE `restaurant_shoutouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`food` text NOT NULL,
	`note` text,
	`added_by` text,
	`created_at` integer NOT NULL
);
