import { clearMediaSession, setupMediaSession, syncMediaSession } from "../../web/src/lib/mediaSession";

let failures = 0;
const assert = (ok: unknown, message: string) => { if (!ok) { failures++; console.error(`FAIL ${message}`); } };

const handlers: Record<string, (() => void) | null> = {};
const session = { metadata: null as unknown, playbackState: "none", setActionHandler: (name: string, fn: (() => void) | null) => { handlers[name] = fn; }, setPositionState: (v: unknown) => { (session as any).position = v; } };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaSession: session } });
Object.defineProperty(globalThis, "MediaMetadata", { configurable: true, value: class { constructor(public value: unknown) {} } });

setupMediaSession({ play: () => {}, seekto: (_details) => {} });
assert(handlers.play && handlers.seekto, "registers supported action handlers");
syncMediaSession({ title: "Song", artist: "Artist" }, "playing", { duration: 100, position: 140 });
assert(session.playbackState === "playing", "syncs playback state");
assert((session as any).position.position === 100, "clamps position to duration");
clearMediaSession();
assert(session.metadata === null && session.playbackState === "none", "clears metadata and state");

delete (navigator as any).mediaSession;
setupMediaSession({ play: (_details) => {} });
assert(true, "unsupported media session degrades silently");
process.exit(failures ? 1 : 0);
