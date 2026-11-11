CREATE TABLE `owner_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`image_keys` text,
	`video_link` text,
	`link_url` text,
	`likes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_post_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL REFERENCES `owner_posts`(`id`),
	`body` text NOT NULL,
	`author_name` text,
	`created_at` integer NOT NULL
);
