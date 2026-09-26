CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT, track INTEGER, disc INTEGER, updated_at INTEGER);
CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT, storage_object_id TEXT);
CREATE TABLE storage_entries (id TEXT PRIMARY KEY, instance_id TEXT, kind TEXT, source_id TEXT, parent_id TEXT, path TEXT, display_name TEXT);
