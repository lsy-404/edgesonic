# Findings

- `Library.vue` opened the editor before `getSong` completed, then replaced `editInitial` asynchronously. `TagEditor` initializes form state only when `open` changes, so it retained the partial row values.
- Await the full response before setting `editorOpen`; a request epoch prevents a delayed response from opening or filling a different song after a switch, batch open, or close.
- No watcher was added for `initialTags`, so later metadata cannot overwrite fields the user has already edited.
