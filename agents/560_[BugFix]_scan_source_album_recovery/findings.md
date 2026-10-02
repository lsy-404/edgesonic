# Findings

- `metadataApply` and `/tag/read` preserve stored identity only when the incoming album name and current album name normalize equal, or current ID matches the source-folder hash. Placeholder/codec-suffixed album names miss both checks, so subsequent scans create/relink to a different album identity.
- A unique `storage_entries` file path is already required by `sourceFolderLogicalPath`; recovery is limited to exact generic labels (`Unknown Album`, `Unknown`, `Album`, or codec-only labels) and codec suffixes attached to the source folder name. A real incoming album name and a usable current album remain authoritative.
- The shared scan helper is used only by the metadata scan and `/tag/read` paths. Manual `/tag/write` remains unchanged.
