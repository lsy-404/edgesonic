INSERT OR IGNORE INTO users
  (username, master_password, level, enabled, activation_status, created_at, updated_at)
VALUES ('pressure_user', 'local-fixture-only', 1, 1, 'permanent', unixepoch(), unixepoch());

INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph)
VALUES (1, 'browse', 1, 0), (1, 'search', 1, 0);

INSERT OR IGNORE INTO sessions
  (id, username, token, auth_source, user_agent, expires_at, created_at)
VALUES ('pressure-session', 'pressure_user', 'pressure-session-token', 'local', 'workerd-pressure-fixture', unixepoch() + 86400, unixepoch());

UPDATE sessions SET expires_at = unixepoch() + 86400 WHERE token = 'pressure-session-token';

WITH RECURSIVE n(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM n WHERE value < 199
)
INSERT OR IGNORE INTO artists (id, name, sort_name)
SELECT 'pressure-artist-' || printf('%03d', value),
       'Pressure Artist ' || printf('%03d', value),
       'Pressure Artist ' || printf('%03d', value)
FROM n;

WITH RECURSIVE n(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM n WHERE value < 499
)
INSERT OR IGNORE INTO albums (id, name, sort_name)
SELECT 'pressure-album-' || printf('%03d', value),
       'Pressure Album ' || printf('%03d', value),
       'Pressure Album ' || printf('%03d', value)
FROM n;

WITH RECURSIVE n(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM n WHERE value < 5999
)
INSERT OR IGNORE INTO song_masters
  (id, album_id, artist_id, title, sort_title, track, disc, duration, lyrics)
SELECT 'pressure-song-' || printf('%05d', value),
       'pressure-album-' || printf('%03d', value % 500),
       'pressure-artist-' || printf('%03d', value % 200),
       'LoadTest Track ' || printf('%05d', value),
       'LoadTest Track ' || printf('%05d', value),
       (value % 20) + 1,
       (value / 20) + 1,
       180,
       '[00:00.00]synthetic pressure lyrics sample'
FROM n;

INSERT OR IGNORE INTO song_instances
  (id, master_id, source_id, source_type, storage_uri, suffix, content_type,
   bit_rate, sample_rate, channels, duration, size, missing, tag_scanned)
SELECT 'pressure-instance-' || substr(id, 15), id, 'r2-local', 'original',
       'r2://pressure-baseline/' || id || '.mp3', 'mp3', 'audio/mpeg',
       192, 44100, 2, 180, 4320000, 0, 1
FROM song_masters WHERE id LIKE 'pressure-song-%';

UPDATE library_stats_cache SET dirty = 1, updated_at = NULL WHERE id = 1;
UPDATE lyrics_search_state SET initialized = 0 WHERE id = 1;
DELETE FROM lyrics_search_dirty;
DELETE FROM lyrics_search_documents;
DELETE FROM lyrics_search_grams;
INSERT OR REPLACE INTO feature_strings (key, value, description, updated_at)
VALUES ('lastfm_fallback_sources', '[]', 'Pressure fixture disables remote artist lookups.', unixepoch());

INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph)
VALUES (1, 'browse', 1, 0), (1, 'search', 1, 0), (1, 'edit_annotations', 1, 0), (1, 'manage_playlists', 1, 0);

WITH RECURSIVE visitor(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM visitor WHERE value < 7
)
INSERT OR IGNORE INTO users
  (username, master_password, level, enabled, activation_status, created_at, updated_at)
SELECT 'pressure_visitor_' || printf('%02d', value), 'local-fixture-only', 1, 1, 'permanent', unixepoch(), unixepoch()
FROM visitor;

WITH RECURSIVE visitor(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM visitor WHERE value < 7
)
INSERT OR IGNORE INTO sessions
  (id, username, token, auth_source, user_agent, expires_at, created_at)
SELECT 'pressure-visitor-session-' || printf('%02d', value),
       'pressure_visitor_' || printf('%02d', value),
       'pressure-visitor-token-' || printf('%02d', value),
       'local', 'workerd-pressure-visit-fixture', unixepoch() + 86400, unixepoch()
FROM visitor;

UPDATE sessions SET expires_at = unixepoch() + 86400 WHERE token LIKE 'pressure-visitor-token-%';
UPDATE artists SET image_r2_key = 'pressure/cover.png', biography = 'Synthetic pressure fixture biography.', biography_source = 'fixture' WHERE id LIKE 'pressure-artist-%';
UPDATE albums SET cover_r2_key = 'pressure/cover.png' WHERE id LIKE 'pressure-album-%';
UPDATE song_masters SET cover_r2_key = 'pressure/cover.png', duration = 5 WHERE id LIKE 'pressure-song-%';
UPDATE song_masters SET lyrics_rich = '{"tracks":[{"kind":"main","lang":"en","synced":true,"line":[{"start":0,"value":"Synthetic"}],"cueLine":[{"index":0,"start":0,"end":5000,"value":"Synthetic","cue":[{"start":0,"end":5000,"value":"Synthetic","byteStart":0,"byteEnd":9}]}],"agents":[]}]}' WHERE id LIKE 'pressure-song-%';
UPDATE song_instances SET storage_uri = 'r2://pressure/audio.wav', suffix = 'wav', content_type = 'audio/wav', bit_rate = 706, sample_rate = 44100, channels = 1, duration = 5, size = 441044 WHERE id LIKE 'pressure-instance-%';

WITH RECURSIVE visitor(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM visitor WHERE value < 7
)
INSERT OR IGNORE INTO playlists (id, name, owner, song_count, duration)
SELECT 'pressure-visitor-playlist-' || printf('%02d', value), 'Fixture playlist',
       'pressure_visitor_' || printf('%02d', value), 1, 5
FROM visitor;

WITH RECURSIVE visitor(value) AS (
  VALUES (0)
  UNION ALL SELECT value + 1 FROM visitor WHERE value < 7
)
INSERT OR IGNORE INTO playlist_songs (playlist_id, song_master_id, position)
SELECT 'pressure-visitor-playlist-' || printf('%02d', value),
       'pressure-song-' || printf('%05d', value), 0
FROM visitor;
