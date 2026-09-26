# Findings

## Production snapshot

- The primary D1 query found 3,448 file entries without an `instance_id`; only nine reference a stable audio object.
- Read-only R2 fetches confirmed all nine physical objects exist.
- Eight entries are retired FLACs from `现实逃避 Project[flac]`. Each has no song instance, no same-object sibling entry, and no companion child. The corresponding WAV entry has a live, scanned instance.
- The remaining entry, `se-c06411c14eb34297bc139e6cf4d37b93`, duplicates `obj_47a3ffc11fbff066.wav`; that object already has active instance `si-mirror-d088f293f8754050`, so it cannot re-enter the scanner's new-object path.

## Retired FLAC inventory

| Entry | Object | Active WAV instance |
| --- | --- | --- |
| `se-93d282bed0ef437d946745205373a49f` | `obj_0718612234f6a736` | `si-upload-c16ec65d-d5c` |
| `se-a3d57e22ee164ede87a934eeaa80ce8b` | `obj_25ef5ea9099fbab6` | `si-upload-27fa6fe4-2ec` |
| `se-ddaee8e0624a498f94132881d4a43850` | `obj_d6c7eec474ae5f18` | `si-upload-a68b01fc-caf` |
| `se-14242e168fbb4118873dfb526a35edfc` | `obj_e968d58a57ed0d4a` | `si-upload-68aea682-ae4` |
| `se-e6467290f5734f5496791a95a2d4dd4a` | `obj_67ef883ef5348e7e` | `si-upload-c3738c7d-71d` |
| `se-61ad923ce7914197ad7a1a34aff920e7` | `obj_b575d1145ee34e20` | `si-upload-3da3887c-7d7` |
| `se-b19e0c5023cf45d4b30cb0adfa818a2e` | `obj_23872c1fb03925b3` | `si-upload-727e7940-ba4` |
| `se-871d1af68e1c41d68116c88c07838894` | `obj_7d24a124759db7f0` | `si-upload-056c8ce3-166` |

## Scanner assessment

The current R2 source is `sync_only`, so completed scans safely skip every new object. If that mode changes to `library`, each of the eight detached FLAC objects reaches the new-object branch in `scan.ts`: it accepts a `kind='file'` entry with a matching `object_id` and `instance_id IS NULL`, creates a new master and instance, then attaches the entry. That would restore the FLAC copies beside their intended WAV replacements.

## Recommendation

Keep the R2 objects and `storage_objects` rows for rollback. In one guarded future D1 transaction, delete only the eight listed detached `storage_entries` rows after rechecking their object IDs, null instances, zero song-instance references, zero same-object siblings, and zero companion children. Removing those registration rows prevents the library scanner from treating the retained rollback objects as import candidates. Do not delete the separate duplicate `se-c06411c14eb34297bc139e6cf4d37b93` in this operation; it is harmless to scanning and needs a separate UI-path cleanup decision.

## Post-remediation verification

- The guarded cleanup removed the eight retired tree entries. A fresh primary read confirms zero remaining entries for those eight object IDs.
- `现实逃避Project` now has eight WAV instances and zero FLAC instances. The eight old `storage_objects` records remain, preserving the intended rollback objects.
- The only remaining detached stable-audio file entry is `se-c06411c14eb34297bc139e6cf4d37b93`, for `obj_47a3ffc11fbff066.wav`. Its object has an active instance, so it follows the scanner update/skip path instead of the new-object branch.

## Remaining orphan-object risk

- There are 367 stable audio `storage_objects` rows with neither a `storage_entries` row nor a `song_instances` row. This includes the eight retained Reality Escape FLAC objects.
- These rows cannot reimport through the current scanner: a new physical object proceeds only when a detached file entry supplies its logical path. An object without an entry fails that lookup and is skipped.
- No additional D1 cleanup is warranted for scanner safety. Retain the 367 object records as rollback metadata unless a separate storage-retention review establishes that their R2 bytes and object metadata are no longer needed.
