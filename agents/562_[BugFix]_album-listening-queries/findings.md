# Findings

- `scrobbleSong` writes `item_type='song'` annotations only.
- `listAlbums` currently qualifies and sorts `frequent`/`recent` using `item_type='album'`, so normal scrobbles cannot populate either list.
- `getTopSongsByArtist` already aggregates song annotation play counts across all users, confirming catalog-level ranking semantics.
- `albumList2Handler` continues fetching the current user's album annotations for Subsonic per-user metadata; computed catalog ranking fields are independent of that mapping.
- `song_masters.album_id` links logical songs to albums; song annotations are unique per user/song/type and include play_count and play_date.
- A single `listening` CTE aggregates song annotations once per album, then drives both qualification and result fields; folder filters remain on album membership and do not scope the global totals.
- `getTopSongsByArtist` already uses all-user song annotation counts, so its existing ranking is consistent and needs no change.
- A test helper initializes Node SQLite from the complete `worker/migrations/Schema.sql`, allowing the list queries and scrobble upsert to run against the production schema.
- Only `frequent` and `recent` need cross-song listening aggregates for WHERE/ORDER BY. Other types retain their previous album-annotation `play_count`/`play_date` values without scanning song annotations.
- `albumList2Handler` separately loads the requesting user's album annotations and passes those to `mapAlbum`; `mapAlbum` derives public `playCount` from that annotation. The catalog aggregate is not required to preserve any public field on other list types.
- Real token+salt (`md5(issuedPassword + salt)`) and plain client-password requests pass `authMiddleware` for enabled level-1 users with an issued `subsonic_credentials` row and `edit_annotations` permission. An absent credential or wrong password is rejected before annotations are written.
- `/rest/scrobble.view` handles repeated `id`/`time` pairs; `submission=false` writes no song play annotations, while accepted submissions update song annotations consumed by authenticated `getAlbumList2.view` frequent/recent queries.
