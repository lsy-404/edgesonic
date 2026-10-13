# Findings

## Schema and fallback

`song_masters.title` and `sort_title` are separate fields. A storage entry carries a human-readable `path` and `display_name`, references a `storage_object`, and may reference a song instance; the instance references a master and an immutable object. Existing storage metadata recovery rejects `objects/` paths and `obj_<hex>` filenames. It only replaces a title when the input is judged lossy. New scan rows derive title from the readable basename, dropping the extension and a leading track number.

## Production inventory

The original inventory query selected masters with a title exactly `obj` or starting with `obj_`; it returned zero rows. The expanded production inventory returned zero rows for all three groups: malformed/object-like titles including `obj`, `obj_*`, and fullwidth variants; storage entries with object-like names or paths; and empty/unknown/garbled title patterns. The queries were read-only (`rows_written: 0`, `changed_db: false`). This does not support any production title update. No title repair or production write should be made from these results.

## Subsonic display path

`SONG_ROW_COLS` and `SONG_ROW_JOINS` select `si.storage_uri` for the preferred playable instance and do not join `storage_entries`. The `getSongMaster`, album songs, and other song list queries use this shared projection. `mapSong` feeds `s.title` and `inst_storage_uri` into `recoverMetadataFromStoragePath`; a physical `r2://objects/obj_<hash>.<suffix>` URI is intentionally rejected by that fallback. Its `path` field is also derived from the physical URI. Thus Subsonic does not use a readable logical filename that may exist in `storage_entries`; the displayed title remains `song_masters.title`, while its path may show the physical object key.

`get-song`, album song lists, and search/list handlers map through `mapSong`; download naming uses `song_masters.title` directly. Any future fallback should use a unique authoritative logical storage entry tied to the selected instance/object and must not treat physical hash keys as titles. Conflicting paths, missing links, and non-original/transcoded instances require explicit exclusion or review.

## Rebased parser review

The shared logical-path fallback and query wiring address the observed display-path gap. Two behavior changes need correction or explicit acceptance before integration:

1. `/tag/submit-upload` no longer rejects cleaned empty metadata. `applyMetadataResult` now seeds `tags.title` from the existing master title, so an empty payload becomes logically nonempty, obtains the lease, relinks/marks the instance `tag_scanned=1`, and consumes the one-shot upload capability. Previously the route returned 400 for no usable fields. Preserve that guard for an empty payload while allowing a valid logical-path-derived title.
2. `/tag/read` changes `parsed ?? (pending upload ? {} : null)` to `parsed ?? {}`, then seeds the current title. This sends files with no parseable tags through the success branch, so instances that previously received `tag_scanned=2` (no usable tags) can be reported as `tag_scanned=1` and pass through album/artist relinking logic. Confirm or gate this on actual path-based recovery before integration.

## Safety recommendation

No production write was performed. The available live inventory supports no production title repair. Keep the pre-update title map and any hypothetical rollback SQL outside source control. The parser review above is code-only and does not change that data conclusion.
