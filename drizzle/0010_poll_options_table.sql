CREATE TABLE poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  label TEXT NOT NULL,
  votes INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX poll_options_poll_id_idx ON poll_options (poll_id);
--> statement-breakpoint
INSERT INTO poll_options (poll_id, label, votes, position, created_at)
  SELECT id, option_a, votes_a, 0, created_at FROM polls WHERE option_a IS NOT NULL AND option_a <> '';
--> statement-breakpoint
INSERT INTO poll_options (poll_id, label, votes, position, created_at)
  SELECT id, option_b, votes_b, 1, created_at FROM polls WHERE option_b IS NOT NULL AND option_b <> '';
--> statement-breakpoint
ALTER TABLE polls DROP COLUMN option_a;
--> statement-breakpoint
ALTER TABLE polls DROP COLUMN option_b;
--> statement-breakpoint
ALTER TABLE polls DROP COLUMN votes_a;
--> statement-breakpoint
ALTER TABLE polls DROP COLUMN votes_b;
