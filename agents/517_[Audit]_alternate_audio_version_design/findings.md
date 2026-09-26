# Findings

## Scope

Read-only design review. This record makes no D1, R2, API, UI, or production-code change.

The preceding PCM audit establishes these facts:

- `2024 夏浪派对「创作」`: the 13 pending WAV tracks differ from their FLAC counterparts by tail audio of about two seconds. They are separate audio versions. The current keeper album contains FLAC tracks 1--13 and WAV track 14.
- `2025「回响」`: the existing 17-track album contains FLAC track 14 and WAV versions of the other 16 tracks. The pending WAV track 14 differs by about 13.33 ms and is titled `ONE SEIF`; the existing FLAC master is titled `ONE SELF`.

Neither difference is an exact duplicate. The files, object relations, and song masters must all remain separate.

## Existing capability

`album_display_groups` and `album_display_group_members` already provide a schema-backed presentation layer above `albums`:

- one album may belong to one display group;
- a group has a canonical `display_name` and ordered album members;
- the API exposes a single group card and, when opened, ordered member albums as `editions`;
- the library folds every member album into one card while preserving each member album ID.

This is sufficient to show a canonical album entry without changing R2 objects, `storage_objects`, `storage_entries`, `song_instances`, or song-master titles.

The present edition UI shows each member album's name, artist, year, cover, and song count. It has no independent member-label field. A truthful edition label must therefore be carried by the member album name unless a later UI/schema extension is intentionally approved.

## Why playback quality cannot represent these variants

The player sends only `format` and `maxBitRate` to `/rest/stream`. The stream handler starts from one `song_master`, then selects one of that master’s `song_instances`, preferring R2, matching an explicitly requested suffix when possible, and otherwise preferring FLAC over other formats. The quality menu offers codec targets such as FLAC and WAV.

That mechanism is appropriate for alternate encodings of the same logical recording. It cannot select a separately titled or PCM-different master. Putting these WAV and FLAC assets under one master would make one title canonical and hide the other (`ONE SEIF` versus `ONE SELF`), while a WAV selection would misleadingly imply that it is only a format conversion. It must not be used for either case.

## Options

### A. Reuse the existing display groups with separate edition albums — recommended

Create no new R2 objects and no new `song_instances`. Keep every pending WAV song master distinct, assign it to a deliberately labelled alternate-edition album, and group that album with the existing keeper album.

For `2024 夏浪派对「创作」`:

1. Keep the current keeper album as the complete baseline: FLAC tracks 1--13 plus its existing WAV track 14.
2. Create one alternate album containing the 13 pending WAV masters only. Its album name should be an explicit factual label, for example `2024 夏浪派对「创作」 (WAV alternate, tracks 1–13)`.
3. Set those 13 existing masters’ `album_id` to the new alternate album. Do not create replacement masters or instances.
4. Create one display group named `2024 夏浪派对「创作」`; add the complete baseline first and the 13-track WAV alternate second.

For `2025「回响」`:

1. Keep the current 17-track mixed-format album unchanged, including its FLAC `ONE SELF` track 14.
2. Create one alternate album containing only the pending WAV track 14 master. Its label should state the exact distinction, for example `2025「回响」 (WAV alternate — ONE SEIF)`.
3. Set that WAV master’s `album_id` to the alternate album. Its title remains exactly `ONE SEIF`; do not normalize it to `ONE SELF`.
4. Create one display group named `2025「回响」`; add the existing full album first and the one-track WAV alternate second.

This uses existing tables only. It preserves physical object identity, stable-object references, paths, embedded tags, per-version master titles, and all track-level relationships. It also makes the partial nature of each alternate explicit instead of inventing a full edition by copying existing bytes or entries.

### B. Merge the WAV and FLAC into one song master with two instances — reject

This would expose the formats through the existing quality selector, but it encodes different recordings as alternatives of the same master. It cannot retain both song titles, and raw automatic playback would choose a format by implementation ordering rather than an intentional audio-version choice.

### C. Add a version label/track-variant data model and picker — defer

A dedicated edition-label column and per-track variant picker could make the 2025 single-track alternate more polished. It needs a migration, API expansion, and UI work. The existing group model already meets the requirement to retain both versions and show one album entry, so this adds scope without solving an integrity gap.

## Concrete recommendation and execution guards

Use option A. It is the smallest durable design and needs no schema migration or R2 duplication.

Before any later production D1 operation, run a fresh primary-only preflight that resolves the exact target album IDs, all 14/17 relevant master IDs, their instance IDs, storage-object IDs, and storage-entry IDs. The mutation must fail closed unless all of the following remain true:

- every intended WAV master has exactly the expected original instance and that instance still resolves to its expected R2 object;
- the existing keeper masters still belong to the intended existing album;
- no target master has an active metadata, transcode, or other job that rewrites album metadata;
- the two proposed display groups do not already exist with conflicting members;
- the target albums have no unexpected user references that require a separate migration plan.

The transaction should create only the new `albums`, update only the identified pending WAV masters’ `album_id`, create the two group rows, and insert their ordered memberships. It must not update `song_instances`, `storage_objects`, `storage_entries`, R2 keys, or the existing song titles. Postflight should verify the two group endpoints, the individual album endpoints, and direct playback of each named alternate track.

## Limitation kept visible to the user

Opening a display group currently asks the listener to choose an edition album before playing. The edition name carries the version label. The global FLAC/WAV quality menu stays a delivery-format control and must not be presented as the selector for the PCM-different alternates.

## Fresh primary preflight and guarded candidate

The fresh primary snapshot was served by the production primary with `changed_db=false` and zero written rows.

- 2024 keeper `al-cb52162ace` has 14 masters, 14 tracks, 3,153 seconds and 397,331,752 bytes. It has no display-group membership.
- Its tracks 1--13 are FLAC; track 14 is WAV master `sm-upload-36994a13-b28` (`夏花挽浪`). That master has its own existing R2 object and tree entry, a per-track cover, 1,278 lyric characters, one lyric document, and one artist-credit row.
- The 13 pending 2024 WAV masters have their own readable R2 objects and tree entries. Their existing titles are retained verbatim. They presently lack structured song metadata, lyrics, and artist-credit rows.
- 2025 keeper `al-d5b2b412d8` has 17 masters, 3,706 seconds and 653,148,224 bytes. It has no display-group membership. Its FLAC track 14 remains `sm-upload-b292b473-d95`, titled `ONE SELF`.
- Pending WAV `sm-upload-9eb3e1f2-7b3` remains separate, titled `14 ONE SEIF`, with its own object and tree entry.
- Across the 15 WAV targets, checked annotations, bookmarks, playlist memberships, share entries, transcode jobs, and active metadata work are zero. No album annotation was found on either keeper.

Moving 2024 WAV track 14 to the new WAV album is therefore GO: its song master, instance, storage object, tree entry, lyric, cover, and artist credit are all retained in place. The candidate leaves its title untouched. It creates a complete 14-track WAV edition and leaves a 13-track FLAC edition.

For 2024 tracks 1--13, the candidate copies only non-title metadata from each corresponding FLAC master to its PCM-different WAV master: artist identity, album artist, genre, participants, per-track cover key, lyrics, rich lyrics, and artist-credit rows. It assigns track/disc order but deliberately preserves the exact WAV titles, including `XTAB-心华` and `XYAB-星尘`. Existing FLAC masters and their metadata remain untouched. The update marks copied lyrics dirty for the normal search-index refresh path; lyric display reads the copied master fields directly.

`guarded_candidate.sql` SHA-256: `f4d0655679253c9f774bb254b1c03d37528cd852888bdcd9c6dcd3813967e535`.

It creates these data-only identities:

- `al-alt-summer-2024-wav`: 14 WAV tracks, grouped after the 13-track FLAC keeper.
- `al-alt-summer-2025-one-seif-wav`: one WAV track (`ONE SEIF`), grouped after the existing 17-track 2025 keeper.
- `adg-alt-summer-2024` and `adg-alt-summer-2025`: canonical display groups with each keeper at sort order zero.

The candidate begins with fail-closed guards for exact keeper aggregates, all selected masters, instances, tree entries, current titles, absence of conflicting groups/new IDs, zero selected references, and no active jobs. It never updates R2 objects, `storage_objects`, `storage_entries`, or `song_instances`.

## Local rehearsal

The local fixture was normalized to the current two keeper shapes and includes a synthetic representation of the 2025 keeper’s unrelated tracks. The selected production IDs, object relations, and the 2024 metadata mapping are retained exactly in the fixture.

- Success: the candidate created both groups and four memberships; the 2024 keeper became 13 tracks / 2,907 seconds / 353,209,208 bytes; the WAV edition became 14 tracks / 3,179 seconds / 561,466,684 bytes; the 2025 keeper remained the first 17-track member and `ONE SEIF` became the one-track alternate.
- Stale: changing a guarded 2024 WAV title before execution caused the first guard to fail. No candidate album or display group was created.
- Late failure: a final intentional invalid queue-row insert failed after the candidate body. D1 rolled the complete batch back: no new album or group remained, the 2024 keeper retained 14 tracks / 3,153 seconds / 397,331,752 bytes, and `ONE SEIF` remained in `pending-uploads` with a null track number.

GO for a fresh production preflight followed by this exact candidate as one D1 batch. The parent must independently rerun the primary guard immediately before any production write; this audit did not execute production D1 or R2 mutations.

## Independent production postflight

After the parent executed the reviewed candidate, an independent primary-only query returned `changed_db=false` and `rows_written=0` for this audit read.

- `2024虚拟歌手夏浪派对` now has 13 FLAC masters / instances, 2,907 seconds, and 353,209,208 bytes. Its WAV edition has 14 WAV masters / instances, 3,179 seconds, and 561,466,684 bytes.
- `2025虚拟歌手夏浪派对` remains a 17-track first member with 1 FLAC and 16 WAV instances. The `ONE SEIF` alternate is a one-track WAV member.
- Both display groups have exactly two members and their keeper albums have sort order zero; four membership rows exist in total.
- The selected 15 WAV targets have 15 nonmissing instances and 15 source-tree entries. No selected master remains in `pending-uploads`.
- The 2024 WAV track 14 retains its original instance, stable object, and source-tree entry. `ONE SELF` remains on the 2025 keeper FLAC master; `14 ONE SEIF` remains unchanged on the WAV alternate, with both original object and tree-entry identities intact.

Production postflight: GO. No Worker or R2 mutation was performed during this independent review.
