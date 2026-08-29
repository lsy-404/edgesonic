import { clearMediaSession, setupMediaSession, syncMediaSession } from "../../web/src/lib/mediaSession";

let failures = 0;
const assert = (ok: unknown, message: string) => { if (!ok) { failures++; console.error(`FAIL ${message}`); } };

const handlers: Record<string, MediaSessionActionHandler | null> = {};
const session = { metadata: null as unknown, playbackState: "none", setActionHandler: (name: string, fn: MediaSessionActionHandler | null) => { handlers[name] = fn; }, setPositionState: (v: unknown) => { (session as any).position = v; } };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaSession: session } });
Object.defineProperty(globalThis, "MediaMetadata", { configurable: true, value: class { constructor(public value: unknown) {} } });

let position = 50;
const seeks: number[] = [];
setupMediaSession({
  currentTime: () => position,
  play: () => {},
  pause: () => {},
  previous: () => {},
  next: () => {},
  seek: (seconds) => { seeks.push(seconds); position = seconds; },
});
assert(handlers.play && handlers.seekto, "registers supported action handlers");
handlers.seekbackward?.({ action: "seekbackward", seekOffset: 5 });
handlers.seekforward?.({ action: "seekforward" });
handlers.seekto?.({ action: "seekto", seekTime: 90 });
assert(seeks.join(",") === "45,55,90", "maps media seek actions to player positions");
syncMediaSession({ title: "Song", artist: "Artist" }, "playing", { duration: 100, position: 140 });
assert(session.playbackState === "playing", "syncs playback state");
assert((session as any).position.position === 100, "clamps position to duration");
clearMediaSession();
assert(session.metadata === null && session.playbackState === "none", "clears metadata and state");

delete (navigator as any).mediaSession;
setupMediaSession({ currentTime: () => 0, play: () => {}, pause: () => {}, previous: () => {}, next: () => {}, seek: () => {} });
assert(true, "unsupported media session degrades silently");
process.exit(failures ? 1 : 0);
