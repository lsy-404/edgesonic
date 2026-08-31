
<script setup lang="ts">
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { usePlayerStore } from "../stores/player";
import { useAuth } from "../api";
import { getTrackLyrics } from "../lib/trackPrefetch";
import { cuePlaybackProgress } from "../lib/lyricProgress";

const player = usePlayerStore();
const { t } = useI18n();
const { coverArtUrl, authFetch, username } = useAuth();

// Lyrics model supports three layers:
//   * cueWord: word-level karaoke rendering. Each line carries an array of
//     cues {start, end?, value}; the current word is highlighted by
//     comparing player.currentTime against cue boundaries.
//   * line: line-level synced text (the legacy v1 path). Falls back here
//     when the server only has LRC or a v1 structuredLyrics entry.
//   * plain: unsynced text; shown statically, no active highlight.
interface LyricCue { start: number; end?: number; value: string }
interface LyricLine {
  time: number;
  text: string;
  tr?: string;
  synced: boolean;
  // word-level cues for this line; empty when only line timing exists.
  cues: LyricCue[];
  // When the source distinguishes multiple vocal agents (main +
  // backing) for the same line, we emit one LyricLine per agent per
  // timestamp, each carrying its own cues + an agent label. The first
  // entry (role=main) leads; subsequent entries render as backing layers.
  agentName?: string;
}
const lyrics = ref<LyricLine[]>([]);
const lyricsLoading = ref(false);
const lyricsError = ref("");
const hasSynced = computed(() => lyrics.value.some((l) => l.synced));
const karaokeTime = ref(0);
const userScrolled = ref(false);
const lyricsScrollEl = ref<HTMLElement | null>(null);
const suppressScrollUntil = ref(0);
const autoScrolling = ref(false);
const ACTIVE_CENTER_TOLERANCE_PX = 24;
let lyricsReturnTimer: ReturnType<typeof setTimeout> | null = null;
let karaokeFrame = 0;
let karaokeAnchorTime = 0;
let karaokeAnchorAt = 0;

function projectedKaraokeTime(now: number): number {
  return karaokeAnchorTime + Math.max(0, now - karaokeAnchorAt) / 1000;
}

function updateKaraokeAnchor(time: number) {
  const now = performance.now();
  const projected = projectedKaraokeTime(now);
  karaokeAnchorTime = time;
  karaokeAnchorAt = now;
  if (!player.playing || Math.abs(time - projected) > 0.12) karaokeTime.value = time;
}

function animateKaraokeTime(now: number) {
  if (!player.playing) {
    karaokeFrame = 0;
    karaokeTime.value = player.currentTime;
    return;
  }
  karaokeTime.value = projectedKaraokeTime(now);
  karaokeFrame = requestAnimationFrame(animateKaraokeTime);
}

function syncKaraokeClock() {
  updateKaraokeAnchor(player.currentTime);
  if (player.playing && !karaokeFrame) karaokeFrame = requestAnimationFrame(animateKaraokeTime);
  if (!player.playing && karaokeFrame) {
    cancelAnimationFrame(karaokeFrame);
    karaokeFrame = 0;
  }
}

watch(() => player.currentTime, syncKaraokeClock, { immediate: true });
watch(() => player.playing, syncKaraokeClock, { immediate: true });

function parseLrcDual(text: string): LyricLine[] {
  const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/g;
  const byTime = new Map<number, { text: string; tr?: string }>();
  let m: RegExpExecArray | null;
  let hasTs = false;
  const ordered: LyricLine[] = [];
  while ((m = re.exec(text)) !== null) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
    const time = min * 60 + sec + ms / 1000;
    const content = m[4].trim();
    hasTs = true;
    const existing = byTime.get(time);
    if (existing) {
      // Same timestamp → second line is translation
      if (!existing.tr) existing.tr = content;
    } else {
      const entry = { text: content, tr: undefined as string | undefined };
      byTime.set(time, entry);
      ordered.push({ time, text: content, synced: true, cues: [] });
    }
  }
  if (!hasTs) {
    return text.split(/\r?\n/).map((t) => t.trim()).filter((t) => t && !isLyricMetadata(t))
      .map((t) => ({ time: 0, text: t, synced: false, cues: [] }));
  }
  // Attach translations
  for (const entry of byTime.entries()) {
    const idx = ordered.findIndex((l) => l.time === entry[0]);
    if (idx >= 0) ordered[idx].tr = entry[1].tr;
  }
  return ordered.sort((a, b) => a.time - b.time);
}

// Parse the XML body of a <structuredLyrics> element into one or more
// LyricLine[]. When cueLine data is present, lines carry `cues`; otherwise
// we fall back to line-only timing.
function parseStructuredLines(inner: string): LyricLine[] {
  const lineRe = /<line\b([^>]*)>([^<]*)<\/line>/g;
  let m: RegExpExecArray | null;
  const raw: { time: number; text: string; hasTime: boolean }[] = [];
  while ((m = lineRe.exec(inner)) !== null) {
    const start = /\bstart\s*=\s*"(\d+)"/i.exec(m[1]);
    const content = decodeEntities(m[2]).trim();
    if (!content || isLyricMetadata(content)) continue;
    raw.push({ time: start ? parseInt(start[1], 10) / 1000 : 0, text: content, hasTime: !!start });
  }
  const hasTs = raw.some((r) => r.hasTime);
  if (!hasTs) {
    // Unsynced lyrics: every line is its own entry, no timestamp grouping.
    return raw.map((r) => ({ time: 0, text: r.text, synced: false, cues: [] }));
  }
  // Only explicitly timestamped adjacent lines share the original/translation
  // convention. Untimed text stays separate and cannot collapse at 0 seconds.
  const ordered: LyricLine[] = [];
  for (const r of raw) {
    const previous = ordered[ordered.length - 1];
    if (r.hasTime && previous?.synced && previous.time === r.time && !previous.tr) {
      previous.tr = r.text;
    } else {
      ordered.push({ time: r.time, text: r.text, synced: r.hasTime, cues: [] });
    }
  }
  return ordered;
}

// Parse the enhanced structuredLyrics payload (with cueLine/cue/
// agents/kind) into LyricLine[]. Each <structuredLyrics> block becomes a
// "track"; we render the main track's lines and overlay the translation
// track's text under each main line via `tr`.
function parseEnhancedStructured(rootXml: string): LyricLine[] {
  // Split into <structuredLyrics ...>...</structuredLyrics> blocks. We do
  // a regex split because trackPrefetch preserves the full
  // structuredLyrics elements from the response.
  const trackRe = /<structuredLyrics\b[^>]*>([\s\S]*?)<\/structuredLyrics>/g;
  const tracks: Array<{
    kind: string;
    cueLines: Map<number, LyricCue[]>;
    agentNames: Map<number, string | undefined>;
    lines: Array<{ index: number; start: number; value: string; hasTime: boolean }>;
    hasTime: boolean;
  }> = [];
  let tm: RegExpExecArray | null;
  while ((tm = trackRe.exec(rootXml)) !== null) {
    const blockAttrs = tm[0].slice(0, tm[0].indexOf(">"));
    const kind = attrVal(blockAttrs, "kind") || "main";
    const inner = tm[1];
    // Lines
    const lineRe = /<line\b([^>]*)>([^<]*)<\/line>/g;
    const lines: Array<{ index: number; start: number; value: string; hasTime: boolean }> = [];
    let lm: RegExpExecArray | null;
    let lineIndex = 0;
    while ((lm = lineRe.exec(inner)) !== null) {
      const index = lineIndex++;
      const startAttr = /\bstart\s*=\s*"(\d+)"/i.exec(lm[1]);
      const hasTime = !!startAttr;
      const start = startAttr ? parseInt(startAttr[1], 10) / 1000 : 0;
      const value = decodeEntities(lm[2]).trim();
      if (!value || isLyricMetadata(value)) continue;
      lines.push({ index, start, value, hasTime });
    }
    const hasTime = lines.some((l) => l.hasTime);
    // cueLine entries
    const cueLines = new Map<number, LyricCue[]>();
    const agentNames = new Map<number, string | undefined>();
    const cueLineRe = /<cueLine\b[^>]*>([\s\S]*?)<\/cueLine>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cueLineRe.exec(inner)) !== null) {
      const clAttrs = cm[0].slice(0, cm[0].indexOf(">"));
      const idx = parseInt(attrVal(clAttrs, "index") || "0", 10);
      const cues: LyricCue[] = [];
      const cueRe = /<cue\b([^>]*?)(?:\/>|>([^<]*)<\/cue>)/g;
      let cum: RegExpExecArray | null;
      while ((cum = cueRe.exec(cm[1])) !== null) {
        const cueAttrs = cum[1];
        const startMs = parseInt(attrVal(cueAttrs, "start") || "0", 10);
        const endMs = attrVal(cueAttrs, "end");
        const value = decodeEntities(attrVal(cueAttrs, "value") ?? cum[2] ?? "");
        if (!value) continue;
        cues.push({ start: startMs / 1000, ...(endMs ? { end: parseInt(endMs, 10) / 1000 } : {}), value });
      }
      cueLines.set(idx, cues);
      const agentId = attrVal(clAttrs, "agentId");
      if (agentId) agentNames.set(idx, agentNameFor(rootXml, agentId));
    }
    tracks.push({ kind, cueLines, agentNames, lines, hasTime });
  }

  if (tracks.length === 0) return [];

  const main = tracks.find((t) => t.kind === "main") ?? tracks[0];
  const translations = tracks.filter((t) => t.kind === "translation");

  const out: LyricLine[] = [];
  main.lines.forEach((line) => {
    const synced = main.hasTime && line.hasTime;
    const cues = main.cueLines.get(line.index) ?? [];
    const agentName = main.agentNames.get(line.index);
    // Find a translation line at the same timestamp.
    let tr: string | undefined;
    for (const t of translations) {
      const match = t.lines.find((tl) => tl.hasTime && line.hasTime && Math.abs(tl.start - line.start) < 0.01);
      if (match) { tr = match.value; break; }
    }
    out.push({ time: line.start, text: line.value, synced, cues, ...(tr ? { tr } : {}), ...(agentName ? { agentName } : {}) });
  });
  return out.sort((a, b) => a.time - b.time);
}

function isLyricMetadata(value: string): boolean {
  return /^\[[a-zA-Z#][^:\]]*:[^\]]*\]$/.test(value);
}

function attrVal(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m ? m[1] : undefined;
}

// Resolve an agentId to a human-readable name by scanning the parent
// structuredLyrics block for a matching <agents> entry.
function agentNameFor(rootXml: string, agentId: string): string | undefined {
  const re = new RegExp(`<agent\\b[^>]*\\bid="${agentId}"[^>]*>`, "i");
  const m = re.exec(rootXml);
  if (!m) return undefined;
  return attrVal(m[0], "name") || undefined;
}

let lyricsRequest = 0;
function resetLyricsScroll() {
  lyricsScrollEl.value?.scrollTo({ top: 0, behavior: "auto" });
}

watch(() => player.current?.id, async (id) => {
  const request = ++lyricsRequest;
  const trackAtChange = player.current;
  if (lyricsReturnTimer) {
    clearTimeout(lyricsReturnTimer);
    lyricsReturnTimer = null;
  }
  userScrolled.value = false;
  suppressScrollUntil.value = Date.now() + 600;
  autoScrolling.value = false;
  lyrics.value = [];
  lyricsError.value = "";
  lyricsLoading.value = !!id;
  resetLyricsScroll();
  await nextTick();
  if (request !== lyricsRequest) return;
  resetLyricsScroll();
  if (!id || !trackAtChange || trackAtChange.id !== id) {
    lyricsLoading.value = false;
    return;
  }
  try {
    const payload = await getTrackLyrics(trackAtChange, { authFetch, scope: username.value });
    if (request !== lyricsRequest) return;
    if (payload.structuredEnhanced) {
      const parsed = parseEnhancedStructured(payload.structuredEnhanced);
      lyrics.value = parsed.length > 0 ? parsed : parseStructuredLines(payload.structuredEnhanced);
    } else if (payload.structured) lyrics.value = parseStructuredLines(payload.structured);
    else if (payload.lrc) lyrics.value = parseLrcDual(decodeEntities(payload.lrc));
  } catch {
    if (request === lyricsRequest) lyricsError.value = t("nowPlaying.lyricsLoadFailed");
  } finally {
    if (request === lyricsRequest) lyricsLoading.value = false;
  }
}, { immediate: true, flush: "sync" });

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

const activeIdx = computed(() => {
  if (!hasSynced.value) return -1;
  const t = player.currentTime;
  let idx = -1;
  for (let i = 0; i < lyrics.value.length; i++) {
    const line = lyrics.value[i];
    if (!line.synced) continue;
    if (line.time <= t) idx = i;
    else break;
  }
  return idx;
});

function cueProgress(line: LyricLine, lineIndex: number, cueIndex: number): number {
  return cuePlaybackProgress(lyrics.value, lineIndex, cueIndex, karaokeTime.value, player.duration);
}

async function centerActiveLyric(idx = activeIdx.value) {
  if (idx < 0 || userScrolled.value || !lyricsScrollEl.value) return;
  await nextTick();
  const container = lyricsScrollEl.value;
  if (!container) return;
  const el = container.querySelectorAll(".np-lyric-line")[idx] as HTMLElement | undefined;
  if (!el) return;
  const target = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
  suppressScrollUntil.value = Date.now() + 600;
  autoScrolling.value = true;
  container.scrollTo({ top: target, behavior: "smooth" });
  setTimeout(() => { autoScrolling.value = false; }, 600);
}

watch(activeIdx, (idx) => {
  void centerActiveLyric(idx);
});

function onLyricsScroll() {
  if (Date.now() < suppressScrollUntil.value) return;
  userScrolled.value = !activeLineIsCentered();
  if (!userScrolled.value) return;
  if (lyricsReturnTimer) clearTimeout(lyricsReturnTimer);
  lyricsReturnTimer = setTimeout(() => {
    userScrolled.value = false;
    void centerActiveLyric();
  }, 1200);
}

onBeforeUnmount(() => {
  if (lyricsReturnTimer) clearTimeout(lyricsReturnTimer);
  if (karaokeFrame) cancelAnimationFrame(karaokeFrame);
});

function activeLineIsCentered(): boolean {
  const idx = activeIdx.value;
  const container = lyricsScrollEl.value;
  if (idx < 0 || !container) return false;
  const el = container.querySelectorAll(".np-lyric-line")[idx] as HTMLElement | undefined;
  if (!el) return false;
  const activeCenter = el.offsetTop + el.clientHeight / 2;
  const viewportCenter = container.scrollTop + container.clientHeight / 2;
  return Math.abs(activeCenter - viewportCenter) <= ACTIVE_CENTER_TOLERANCE_PX;
}

function onLyricClick(line: LyricLine) {
  if (!line.synced || !player.hasTrack) return;
  userScrolled.value = false;
  player.seek(line.time);
  if (!player.playing) player.toggle();
}

const coverFailed = ref(false);
const track = computed(() => player.current);
const coverSrc = computed(() => {
  const tr = track.value;
  return tr?.coverArt ? coverArtUrl(tr.coverArt, 512) : "";
});
// Server cover 404: fall back to embedded art extracted from buffered audio.
const displayCoverSrc = computed(() => (!coverFailed.value && coverSrc.value) || player.localCoverUrl || "");
function onCoverError() {
  coverFailed.value = true;
  void player.reportCoverMissing();
}
watch(coverSrc, (src) => {
  coverFailed.value = false;
  if (!src && player.hasTrack) void player.reportCoverMissing();
}, { immediate: true });

</script>

<template>
  <div class="nowplaying">
    <!-- Left: cover + controls -->
    <div class="np-left">
      <div class="np-cover-wrap">
        <img v-if="displayCoverSrc" :src="displayCoverSrc" class="np-cover" @error="onCoverError" alt="cover" />
        <div v-else class="np-cover-placeholder"><span class="np-placeholder-icon" v-html="'<svg viewBox=\'0 0 24 24\' width=\'48\' height=\'48\'><path fill=\'currentColor\' d=\'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z\'/></svg>'"></span></div>
      </div>
      <div class="np-track-info">
        <div class="np-title">{{ track?.title || "—" }}</div>
        <div class="np-artist">{{ track?.artist || "" }}</div>
        <div class="np-album" v-if="track?.album">{{ track.album }}</div>
      </div>

    </div>

    <!-- Right: lyrics with auto-scroll + translation + word karaoke -->
    <div class="np-right" :class="{ 'auto-scrolling': autoScrolling }" ref="lyricsScrollEl" @scroll.passive="onLyricsScroll">
      <div v-if="lyricsLoading" class="np-lyrics-status">{{ t("nowPlaying.lyricsLoading") }}</div>
      <div v-else-if="lyricsError" class="np-lyrics-status">{{ lyricsError }}</div>
      <div v-else-if="lyrics.length === 0" class="np-lyrics-status">{{ t("nowPlaying.lyricsEmpty") }}</div>
      <div v-else class="np-lyrics-scroll">
        <div class="np-lyrics-spacer"></div>
        <div
          v-for="(line, i) in lyrics"
          :key="i"
          class="np-lyric-line"
          :class="{ active: hasSynced && i === activeIdx, clickable: line.synced }"
          @click="onLyricClick(line)"
        >
          <!-- Karaoke word spans when cueLine data is available -->
          <div v-if="line.cues.length > 0" class="np-lyric-original np-lyric-karaoke">
            <span
              v-for="(cue, ci) in line.cues"
              :key="ci"
              class="np-cue"
              :style="{ '--cue-progress': cueProgress(line, i, ci) }"
            >{{ cue.value }}</span>
          </div>
          <div v-else class="np-lyric-original">{{ line.text }}</div>
          <div v-if="line.agentName" class="np-lyric-agent">{{ line.agentName }}</div>
          <div v-if="line.tr" class="np-lyric-translation">{{ line.tr }}</div>
        </div>
        <div class="np-lyrics-spacer"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nowplaying {
  position: relative;
  display: flex;
  height: calc(100vh - var(--nav-h) - var(--player-h));
  padding: 1.5rem 1.5rem 0.5rem;
  gap: 1.5rem;
  overflow: hidden;
}

/* Left: cover + controls */
.np-left {
  flex: 0 0 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
}
.np-cover-wrap {
  position: relative;
  width: 280px;
  height: 280px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  background: var(--color-bg-tertiary);
}
.np-cover { width: 100%; height: 100%; object-fit: cover; display: block; }
.np-cover-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: var(--color-text-muted);
}
.np-track-info { text-align: center; }
.np-title { font-size: 1.2rem; font-weight: 600; color: var(--color-text-primary); margin-bottom: 0.2rem; }
.np-artist { font-size: 0.95rem; color: var(--color-text-secondary); }
.np-album { font-size: var(--fs-sm); color: var(--color-text-muted); margin-top: 0.1rem; }


/* Right: lyrics */
.np-right {
  flex: 1;
  overflow-y: auto;
  position: relative;
  scrollbar-width: none;
}
.np-right::-webkit-scrollbar { display: none; }

.np-lyrics-status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: 1rem;
}
.np-lyrics-scroll {
  scroll-behavior: smooth;
}
.np-lyrics-spacer { height: 40vh; }
.np-lyric-line {
  padding: 0.6rem 1rem;
  text-align: center;
  transition: opacity 0.3s, color 0.3s, transform 0.3s;
  opacity: 0.4;
}
.np-lyric-line.clickable { cursor: pointer; }
.np-lyric-line.clickable:hover { opacity: 0.75; }
.np-lyric-line.active {
  opacity: 1;
  transform: scale(1.05);
}
.np-lyric-original {
  font-size: 1.05rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.np-lyric-line.active .np-lyric-original {
  color: var(--color-accent-primary);
  font-weight: 500;
  font-size: 1.2rem;
}
.np-lyric-translation {
  font-size: 0.9rem;
  color: var(--color-text-muted);
  margin-top: 0.2rem;
  line-height: 1.4;
}
.np-lyric-line.active .np-lyric-translation {
  color: var(--color-text-secondary);
}

/* word karaoke */
.np-lyric-karaoke { display: inline; }
.np-cue {
  --cue-progress: 0;
  --cue-edge: 3px;
  color: transparent;
  background: linear-gradient(
    90deg,
    var(--color-accent-primary) 0%,
    var(--color-accent-primary) calc(var(--cue-progress) * 100% - var(--cue-edge)),
    color-mix(in srgb, var(--color-accent-primary), var(--color-text-muted)) calc(var(--cue-progress) * 100%),
    var(--color-text-muted) calc(var(--cue-progress) * 100% + var(--cue-edge)),
    var(--color-text-muted) 100%
  );
  background-clip: text;
  -webkit-background-clip: text;
  will-change: background;
  white-space: pre;
}
.np-lyric-agent {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  margin-top: 0.1rem;
  font-style: italic;
}


/* Mobile */
@media (max-width: 768px) {
  .nowplaying { flex-direction: column; padding: 0.5rem; gap: 0.5rem; }
  .np-left { flex: none; }
  .np-cover-wrap { width: min(180px, 28vh); height: min(180px, 28vh); }
  .np-right { flex: 1; min-height: 0; }
}
</style>
