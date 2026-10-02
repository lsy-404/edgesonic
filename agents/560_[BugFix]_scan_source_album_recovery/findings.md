# Findings

- `metadataApply` and `/tag/read` preserve stored identity only when the incoming album name and current album name normalize equal, or current ID matches the source-folder hash. Placeholder/codec-suffixed album names miss both checks, so subsequent scans create/relink to a different album identity.
- A unique `storage_entries` file path is already required by `sourceFolderLogicalPath`; recovery is limited to exact generic labels (`Unknown Album`, `Unknown`, `Album`, or codec-only labels) and codec suffixes attached to the source folder name. A real incoming album name and a usable current album remain authoritative.
- The shared scan helper is used only by the metadata scan and `/tag/read` paths. Manual `/tag/write` remains unchanged.
## Review correction

The initial generic path ID may not match the ID of an existing manually merged/canonical album in that same folder. Source-folder recovery now queries only when the current value is generic/codec-suffixed; it reuses exactly one existing album whose name equals the recovered source album, and declines if multiple such identities exist. This prevents creating another split album for the `24 correct + 4 placeholder` folder pattern while retaining ambiguous versions.
