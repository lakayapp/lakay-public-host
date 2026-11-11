CREATE TABLE supporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT,
  amount_cents INTEGER,
  tier TEXT,
  recipient TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
