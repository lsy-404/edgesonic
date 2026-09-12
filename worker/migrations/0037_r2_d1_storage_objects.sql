-- D1 applies migrations once; CREATE statements remain safe for retries.
CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  physical_key TEXT NOT NULL UNIQUE,
  legacy_key TEXT UNIQUE,
  suffix TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

ALTER TABLE song_instances ADD COLUMN storage_object_id TEXT REFERENCES storage_objects(id);

CREATE TABLE IF NOT EXISTS storage_entries (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  parent_id TEXT,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0 AND instr(display_name, '/') = 0),
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  object_id TEXT,
  instance_id TEXT,
  companion_of TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  CHECK ((kind = 'folder' AND object_id IS NULL) OR (kind = 'file' AND object_id IS NOT NULL)),
  FOREIGN KEY (source_id) REFERENCES storage_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES storage_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (object_id) REFERENCES storage_objects(id) ON DELETE RESTRICT,
  FOREIGN KEY (instance_id) REFERENCES song_instances(id) ON DELETE SET NULL,
  FOREIGN KEY (companion_of) REFERENCES storage_entries(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_entries_parent_name
  ON storage_entries(source_id, COALESCE(parent_id, ''), display_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_entries_source_path
  ON storage_entries(source_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_objects_legacy_key
  ON storage_objects(legacy_key) WHERE legacy_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_storage_object ON song_instances(storage_object_id);
CREATE INDEX IF NOT EXISTS idx_storage_entries_parent ON storage_entries(parent_id);
CREATE INDEX IF NOT EXISTS idx_storage_entries_object ON storage_entries(object_id);
CREATE INDEX IF NOT EXISTS idx_storage_entries_instance ON storage_entries(instance_id);
