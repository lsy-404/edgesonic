# Findings

## Scope

The production database and R2 remain read-only. Instrumental and bonus paths are treated as distinct recordings from similarly named vocal tracks unless exact lossless PCM evidence proves a duplicate.

## Read-only primary audit

- `众虫皆歌/伴奏` has ten active, tagged WAV entries, each with a distinct R2 object. They are all still in `pending-uploads` and have no track or disc number. Its vocal release has the same complete one through ten sequence, but the instrumental paths and masters remain separate recordings.
- `兰音.2024.《形神合一》/伴奏` has ten active WAV entries against ten vocal entries. One accompaniment master is already attached to a noncanonical pending-named album, so the group is not safe for this batch.
- The named Days release mixes MP3 distribution files, lossless vocal masters, six instrumental masters, and Vocaloid bonus variants. Several title spellings also diverge. It is audit-only until lossless PCM comparisons establish any exact pairing.

## Candidate and boundary

The guarded candidate creates `众虫皆歌（伴奏）` as a separate ten-track WAV edition. It does not merge audio masters, copies no vocal title or artist fields, and makes no R2 change. The candidate requires the exact master, instance, object, entry, path, suffix, active-state, and tag-state snapshot.

## Fresh primary preflight

The final read-only primary check returned ten rows, ten masters, ten distinct R2 physical keys, `pending-uploads` for every master, `missing=0`, `tag_scanned=1`, and no existing disc or track values. The query was served by the primary and reported zero rows written.
