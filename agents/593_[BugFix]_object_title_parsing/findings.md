# Findings

## Confirmed behavior
- Upload registers the requested logical entry path in `storage_entries.path`, while `song_instances.storage_uri` for R2 points at `objects/obj_<16 hex>.<suffix>`.
- `/tag/submit-upload` and queued metadata apply both call `applyMetadataResult`. That shared helper resolves one unique logical path. A stored title is used as a fallback only when a readable logical filename exists; the path helper then replaces only an empty, lossy, exact `obj`, or generated hash title.
- `/tag/submit-upload` accepts empty parsed tags only when a readable logical filename can supply the missing title. Without one it returns 400 before acquiring the upload metadata lease.
- `/tag/read` uses filename-only recovery only when the current title is missing/lossy/object-placeholder, or the album is still `pending-uploads`, and a readable logical filename exists. It delegates this case to `applyMetadataResult`, which preserves artist and album identity when already known. If parsing yields no identity and no eligible filename fallback exists, the row remains at `tag_scanned=2` without relinking.
- Subsonic list/detail/search queries used only the selected `storage_uri`. The selected song and its original logical path are now projected independently; detail source selection carries the same path. Response mapping uses the logical path when present and keeps physical `path` output based on storage URI.
- `workMetadataRetrieval.missingIdentitySql` had a broad `obj_[0-9a-f]*` prefix pattern. It now recognizes only exact `obj` or the current generated `obj_` plus 16 hexadecimal digits; `Objective` is not classified as a placeholder.

## Boundaries retained
- Recovery only replaces title when it is blank, lossy, exact `obj`, or `obj_` followed by 16–64 hex digits. `Objective` and other titles remain untouched.
- Album and artist fields retain current values unless they independently meet the pre-existing lossy-text rule.
- Physical object URIs continue through `recoverMetadataFromStoragePath`, which refuses object keys. A path explicitly sourced from `storage_entries` uses `recoverMetadataFromLogicalPath`; a direct `objects/obj_<hash>.<suffix>` physical key is rejected even if mistakenly stored as the logical path.
- Filename-only reparse bypasses track-artist reconstruction for existing songs. Pending uploads may still resolve the album from their indexed folder while retaining current artist identities.

## Validation note
- Initial Worker typecheck exposed a path-field type mismatch where `selectSongSource` erased the computed field. The selected source row was corrected to retain the optional logical path in the entity type.
- The first new filename-only reparse test exposed that the normal read-tag relink path regenerated the current artist ID; filename-only handling now uses the shared apply path, and the regression verifies album and artist identity retention.
- Final Worker typecheck and all five targeted suites passed after rebasing on the latest `origin/main`.
