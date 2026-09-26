CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  year INTEGER,
  genre TEXT,
  cover_r2_key TEXT,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  compilation INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

INSERT INTO albums(id, name) VALUES
  ('al-a1', 'Album A'), ('al-a2', 'Album A'), ('al-a3', 'Album A'), ('al-a4', 'Album A'),
  ('al-b1', 'Album B'), ('al-b2', 'Album B'), ('al-b3', 'Album B'), ('al-b4', 'Album B'), ('al-b5', 'Album B');
