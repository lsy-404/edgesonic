# Findings

- Production preflight: the existing OAuth token had no D1/Containers scopes (D1 error 7403; container scope check rejected). Explicit user authorization plus an Edge OAuth flow resolved the permissions. The first localhost callback was refused with IPv6 binding; explicit 127.0.0.1 binding succeeded.
- The default Docker socket was absent. An existing Colima profile supports amd64 builds through emulation; no new daemon or system-wide Docker configuration was needed. The buildx plugin was already installed and used through an isolated CLI config.
- Local production TOML was stale relative to live cron and Sandbox settings. Deployment config is generated from the existing resource identifiers and live API snapshots, retaining both crons and the current Sandbox digest/lite size. Only the new media container is added.
- Wrangler D1 file execution with --json still emitted progress lines before JSON; the initial JSON parser failed, but the operation itself returned success. A subsequent SQL read verified the resulting tables and foreign keys.

- The previous implementation requires an external media-service address and secret, even though an existing Sandbox transcode runtime is available.
- The existing host page exposes management UI permanently and uses a two-minute controller lease.
- Platform session integration is absent. YouTube OAuth cannot be used as a substitute for the extractor's supported account-session mechanism.

- User approved a new integrated MediaContainer; compatibility mode remains available without it and can optionally embed independent videos or pair muted iframe with library audio.
- Official Bilibili embed documentation confirms autoplay, muted and p parameters. Compatibility video loaded and played through an actual iframe; changing stage layout preserved its playback.
- Fast compatibility preparation exposed an HTTP/WebSocket ordering race. The client now accepts monotonically newer room snapshots, and action responses read the latest persisted state.
- Fullscreen QR initially used whole-image opacity. User corrected this to translucent background only, zero outer padding by default, stronger transparency and slight blur. User confirmed physical scanning works; pointer hover/focus restores opaque white and four-module quiet zone. The hover screenshot decodes successfully with ZXing.
- A short invitation is a collision-reserved six-digit PIN. After the final route correction it uses `/#/k?c=...`; `/#/k` supports manual entry. Lookup checks live room authority. Rotate and close both invalidate the old PIN (HTTP 404 after each action).
- Only preparation and real fullscreen modes remain. Explicit Escape handling returns to preparation, including in the preview browser's synthetic keyboard path.
- An inactive synthetic room was removed by its five-minute alarm. Creation exposes a twelve-hour absolute maximum.
- Subsonic-related baseline comparison: the same six files fail before/after due to existing fixture/schema mismatches; 33 files pass. Focused player lifecycle, endpoint coverage, recipe and configuration checks report 11 passing tests.
- Anonymous Node service checks cover both platform searches, YouTube metadata resolution, Bilibili QR waiting state and synthetic credential scoping/cleanup. Real premium-account playback and an authenticated Bilibili QR completion were not exercised.
- At the initial packaging gate the default Docker daemon was unavailable; the existing Colima profile later resolved this. The Cloudflare media image and application have now been deployed, and the existing Sandbox application reported no changes.
- Production Edge verified anonymous Bilibili AV input from a named guest, queued metadata preparation, native controlled playback with danmaku, pause, seeking to eight seconds, listen-only mode retaining that paused position, real fullscreen and Escape return. Background-tab fullscreen is rejected by the browser as expected; the foreground flow succeeded.
- Production preparation showed a blank room-code label despite correct invitations and successful manual joining. Its computed value was still parsing the pathname query after the hash-route change. Updated that one reader to the hash query in 941ba111.
- The production video and link tables remain empty after anonymous temporary playback. Closing the verification room makes its invitation return HTTP 404. No platform account was connected or external video saved.
- Edge blocked direct navigation to the authenticated Subsonic JSON endpoint with ERR_BLOCKED_BY_CLIENT. The unauthenticated live request returns the expected protocol error; functional Subsonic coverage remains the existing local and CI checks.
- The guest document initially returned 404 with the local worker-first /ktv/* asset setting. Explicit static-document dispatch before the room API resolves this. Hono get() rejected array paths; its on() route API and the existing Env cast passed typecheck and returned HTTP 200/no-store.
- The global CSS reset removes dialog's default auto margin. Setting margin:auto restores centering (680 by 478 at x481/y214.5 in a 1642 by 907 viewport).
