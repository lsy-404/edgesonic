CREATE TABLE IF NOT EXISTS user_messages (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('admin', 'system', 'official')),
  kind TEXT NOT NULL CHECK (kind IN ('info', 'notice', 'warning')),
  presentation TEXT NOT NULL CHECK (presentation IN ('inbox', 'modal')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT,
  read_at INTEGER,
  dismissed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_messages_user_created ON user_messages(username, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_messages_dedupe ON user_messages(username, dedupe_key) WHERE dedupe_key IS NOT NULL;
