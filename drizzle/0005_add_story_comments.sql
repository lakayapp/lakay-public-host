CREATE TABLE story_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id INTEGER NOT NULL REFERENCES stories(id),
  body TEXT NOT NULL,
  author_name TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX story_comments_story_id_idx ON story_comments (story_id);
