# Findings

- Metadata relink moves exactly one master between old/new album IDs, replaces that master's `song_artists` rows only when the primary artist tag is present, and can change `album_artist_id` when a non-empty album artist tag is present.
- Album cleanup now deletes only `oldAlbumId` when it differs from the chosen album ID and no master references it. The existing album-ID index bounds the existence probe.
- Artist cleanup candidates are the old primary artist plus that master's old `song_artists` IDs when primary artist credits are replaced, and the old album artist only when a new non-empty album artist replaces it. Deletion checks all three reference types; IDs still in use survive.
- `song_masters.album_artist_id` had no index. Added `idx_songmasters_album_artist` so candidate checks remain indexed while preserving all-reference semantics. The cleanup statement's `id IN (...)` limits outer artist rows to candidates.
- Tests verify obsolete displaced rows are removed, unrelated empty rows are untouched, album artist and song-artist references preserve candidates, and SQLite selects the new index.
- No production D1 access or writes were performed.
