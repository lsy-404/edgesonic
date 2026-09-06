# Music interface browser fixture

Run `npm ci`, then `node test/ui-refresh/server.mjs` from the repository root.
Open `http://127.0.0.1:5199/` to exercise the actual web application against an isolated fixture API. Covers are synthetic SVGs and audio is a silent WAV. No production service or credentials are used.

Use `?theme=white&lang=en` for the light English interface. The `scenario` query supports `empty`, `partial` (popular albums fail), `error`, `guest`, and `login`. The `/__fixture/events` endpoint reports fixture API requests and runtime errors.

Verify at desktop, tablet, and phone widths:

- Home playback, album/artist details, and close preserve the source URL and search.
- The player keeps playing through ordinary page navigation and detail open/close.
- Playlists retain their list behind details; editing appears above the detail and Escape closes only the current layer.
- The mobile bottom navigation stays below the player, including its More dialog.
- Guest navigation excludes privileged pages, and direct privileged routes are rejected.
- Failed home sections show retry while independent sections render; an empty library shows the appropriate import action.
- Dark and light themes keep controls, menus, and player surfaces consistent.
