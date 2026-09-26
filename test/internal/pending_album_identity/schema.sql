CREATE TABLE work_queue (id TEXT PRIMARY KEY, task_type TEXT, payload TEXT, status TEXT CHECK(status IN ('queued','claimed','completed','failed')), created_at INTEGER);
CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, track INTEGER, disc INTEGER, duration INTEGER, updated_at INTEGER);
CREATE TABLE storage_objects (id TEXT PRIMARY KEY, physical_key TEXT NOT NULL, suffix TEXT NOT NULL, size INTEGER NOT NULL);
CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT NOT NULL, source_id TEXT NOT NULL, source_type TEXT, suffix TEXT NOT NULL, size INTEGER, duration INTEGER, missing INTEGER, tag_scanned INTEGER, storage_object_id TEXT NOT NULL);
CREATE TABLE storage_entries (id TEXT PRIMARY KEY, parent_id TEXT, path TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT, instance_id TEXT);
