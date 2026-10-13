CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('file', 'youtube', 'bilibili')),
  title TEXT NOT NULL,
  duration INTEGER,
  width INTEGER,
  height INTEGER,
  suffix TEXT,
  content_type TEXT,
  size INTEGER,
  source_id TEXT REFERENCES storage_sources(id) ON DELETE CASCADE,
  storage_entry_id TEXT UNIQUE REFERENCES storage_entries(id) ON DELETE CASCADE,
  storage_uri TEXT,
  external_url TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((provider = 'file' AND source_id IS NOT NULL AND storage_uri IS NOT NULL AND external_url IS NULL)
      OR (provider IN ('youtube', 'bilibili') AND source_id IS NULL AND storage_uri IS NULL AND external_url IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_storage_uri ON videos(source_id, storage_uri) WHERE storage_uri IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_external_url ON videos(provider, external_url) WHERE external_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_videos_title ON videos(title);

CREATE TABLE IF NOT EXISTS video_audio_links (
  video_id TEXT NOT NULL,
  audio_id TEXT NOT NULL,
  offset_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (video_id, audio_id),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (audio_id) REFERENCES song_masters(id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_video_audio_links_audio ON video_audio_links(audio_id, video_id);
CREATE INDEX IF NOT EXISTS idx_video_audio_links_audio ON video_audio_links(audio_id, video_id);
