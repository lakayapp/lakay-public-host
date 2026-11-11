DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_name TEXT,
  hearts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  topic TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  answered_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE spotlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist TEXT NOT NULL,
  genre TEXT NOT NULL,
  note TEXT NOT NULL,
  link TEXT,
  added_by TEXT,
  created_at INTEGER NOT NULL
);
