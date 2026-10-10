# Findings
- `SongRowMenu` already exposed “View in Files”, but `Library.vue` used the song's default instance path. Songs with multiple copies could navigate to the wrong source.
- The new location endpoint resolves the song master to each exact `song_instances` and `storage_entries` pair. UI labels show source names and logical filenames, never internal instance/object IDs.
- Library deletion is restricted to users with file management, delete permission, and administrator level. It navigates to the existing file manager confirmation. R2 entries only are offered because the existing delete endpoint handles R2.
- The old delete endpoint removed the R2 key and object row even if other entries/instances referenced them. It now resolves the requested logical path, verifies its physical key, removes only the selected entry, and removes the instance/object only after checking remaining references.
- Full `pnpm run typecheck` passes across worker, web, and installer.
- Initial typecheck attempt could not start because dependencies were absent. `pnpm install --frozen-lockfile` restored them without lockfile changes; final typecheck passed.
