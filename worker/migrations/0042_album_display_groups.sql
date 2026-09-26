CREATE TABLE IF NOT EXISTS album_display_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS album_display_group_members (
  group_id TEXT NOT NULL,
  album_id TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, album_id),
  FOREIGN KEY (group_id) REFERENCES album_display_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_album_display_group_members_order
  ON album_display_group_members(group_id, sort_order, album_id);

CREATE TRIGGER IF NOT EXISTS trg_album_delete_invalidates_display_group
BEFORE DELETE ON albums
WHEN EXISTS (
  SELECT 1 FROM album_display_group_members WHERE album_id = OLD.id
)
BEGIN
  DELETE FROM album_display_group_members
  WHERE group_id IN (
    SELECT group_id FROM album_display_group_members WHERE album_id = OLD.id
  ) AND album_id != OLD.id;
  DELETE FROM album_display_groups
  WHERE id IN (
    SELECT group_id FROM album_display_group_members WHERE album_id = OLD.id
  );
  DELETE FROM album_display_group_members WHERE album_id = OLD.id;
END;
