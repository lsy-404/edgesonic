# Findings

- origin/main at task start: 205a746e. The primary checkout is ahead by two older commits and behind remote main, with storage-related changes last modified on 2026-09-18.
- The retained feat/ktv-mode ref points to July source without KTV modules. The historical plan is available only in the primary checkout's local agents directory.
- Current playback uses a Pinia audio queue and two HTMLAudioElement instances. The Subsonic model currently emits isVideo=false.
- Upstream Subsonic specifies getVideos, getVideoInfo, stream/download, hls.m3u8, getCaptions and video dimensions. Native captions and timed danmaku are separate data.
- Repository package manager is pnpm@10.34.6. Existing runtime includes Vue, Hono, Cloudflare Sandbox and an optional external Node/FFmpeg transcoder.
- Subsonic video/catalog implementation is delegated in codex/subsonic-video. Its scope includes independent video objects, many-to-many links, native storage discovery and protocol endpoints; the primary agent owns session transport, KTV, audit and review.
- Worker typecheck passed after introducing the authenticated loader client.
- Primary integration review identified suffix mismatch between Worker uploads and the loader, HLS cache keys missing audio mode/track, untracked HLS subprocess lifetimes, a missing standard hls.m3u8 route, repeated uncached video probing and unusable default caption selection. Follow-up repairs were assigned to the respective implementation branches before acceptance.
- Local runtime initially rejected a current-date compatibility setting because the pinned workerd supports dates only through 2026-10-03. The local fixture now uses the project's existing production compatibility date (2025-05-24), avoiding an unrelated runtime upgrade.
- Real uploads exposed overlapping MP4 audio/video suffix classification. Explicit audio MIME remains audio; video MP4 now enters only the video catalog.
- Workers rejects redirect:error; direct media service calls now use manual redirect handling and reject redirects.
- Bilibili multi-part references retain p; p1 and p2 resolved to distinct titles and durations. yt-dlp required subtitle extraction options before it returned danmaku metadata.
- Browser review corrected repeated-song restart, restored room playback, mode-switch position capture, stale asynchronous media results, pagination offsets, audio/video player overlap and socket disposal.
- The final loader returns Bilibili timed XML and native or platform VTT/SRT captions. Ordinary YouTube comments are not treated as timed danmaku.
- Local Docker image execution was unavailable because the Docker daemon was not running. Node, ffmpeg and yt-dlp service execution was verified directly.
