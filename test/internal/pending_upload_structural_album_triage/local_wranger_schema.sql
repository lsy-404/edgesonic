CREATE TABLE work_queue (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed')),
  created_at INTEGER NOT NULL
);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  year INTEGER,
  cover_r2_key TEXT,
  song_count INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE song_masters (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  title TEXT NOT NULL,
  track INTEGER,
  disc INTEGER,
  duration INTEGER,
  updated_at INTEGER
);

CREATE TABLE storage_objects (
  id TEXT PRIMARY KEY,
  physical_key TEXT NOT NULL,
  suffix TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE song_instances (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  storage_object_id TEXT NOT NULL,
  suffix TEXT NOT NULL,
  size INTEGER,
  duration INTEGER,
  missing INTEGER NOT NULL DEFAULT 0,
  tag_scanned INTEGER NOT NULL DEFAULT 0,
  source_etag TEXT
);

CREATE TABLE storage_entries (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_id TEXT,
  instance_id TEXT
);

CREATE TABLE album_display_group_members (
  group_id TEXT NOT NULL,
  album_id TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, album_id)
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL
);
