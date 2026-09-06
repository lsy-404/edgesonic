const INDEX_VERSION = 1;
const INIT_BATCH_SIZE = 12;
const GRAM_QUERY_CHUNK = 64;
const SONG_QUERY_CHUNK = 80;
const ensuredDatabases = new WeakSet<object>();

interface LyricsRow {
  id: string;
  lyrics: string | null;
  lyrics_rich: string | null;
}

export type LyricsSearchProgress = "ready" | "building";

function normalizePlainLyrics(value: string): string {
  return value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[a-zA-Z#][^\]]*\]$/.test(line))
    .map((line) => line.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, ""))
    .filter(Boolean).join(" ");
}

function richValues(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { tracks?: Array<{ line?: Array<{ value?: unknown }>; cueLine?: Array<{ value?: unknown; cue?: Array<{ value?: unknown }> }> }> };
    return (parsed.tracks ?? []).flatMap((track) => [
      ...(track.line ?? []).map((line) => typeof line.value === "string" ? line.value : ""),
      ...(track.cueLine ?? []).flatMap((line) => [
        typeof line.value === "string" ? line.value : "",
        ...(line.cue ?? []).map((cue) => typeof cue.value === "string" ? cue.value : ""),
      ]),
    ]).filter(Boolean);
  } catch {
    return [];
  }
}

export function normalizeLyricsSearchText(lyrics: string | null, lyricsRich: string | null): string {
  return [lyrics ? normalizePlainLyrics(lyrics) : "", ...richValues(lyricsRich).map(normalizePlainLyrics)]
    .filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function grams(text: string): string[] {
  const chars = Array.from(text);
  const out = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    out.add(chars[i]);
    if (i + 1 < chars.length) out.add(chars[i] + chars[i + 1]);
  }
  return [...out];
}

async function ensureLyricsSearchSchema(db: D1Database): Promise<void> {
  if (ensuredDatabases.has(db as object)) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS lyrics_search_documents (song_id TEXT PRIMARY KEY, body TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS lyrics_search_grams (gram TEXT NOT NULL, song_id TEXT NOT NULL, PRIMARY KEY (gram, song_id)) WITHOUT ROWID").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS lyrics_search_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, status TEXT NOT NULL, last_song_id TEXT NOT NULL DEFAULT '')").run();
  ensuredDatabases.add(db as object);
}

async function replaceSongIndex(db: D1Database, songId: string, lyrics: string | null, lyricsRich: string | null): Promise<void> {
  const body = normalizeLyricsSearchText(lyrics, lyricsRich);
  await db.prepare("DELETE FROM lyrics_search_grams WHERE song_id = ?").bind(songId).run();
  await db.prepare("DELETE FROM lyrics_search_documents WHERE song_id = ?").bind(songId).run();
  if (!body) return;
  await db.prepare("INSERT INTO lyrics_search_documents (song_id, body) VALUES (?, ?)").bind(songId, body).run();
  const allGrams = grams(body);
  for (const group of Array.from({ length: Math.ceil(allGrams.length / SONG_QUERY_CHUNK) }, (_, i) => allGrams.slice(i * SONG_QUERY_CHUNK, (i + 1) * SONG_QUERY_CHUNK))) {
    await db.prepare("INSERT INTO lyrics_search_grams (gram, song_id) SELECT value, ? FROM json_each(?)")
      .bind(songId, JSON.stringify(group)).run();
  }
}

export async function syncLyricsSearchForSong(db: D1Database, songId: string): Promise<void> {
  await ensureLyricsSearchSchema(db);
  const row = await db.prepare("SELECT id, lyrics, lyrics_rich FROM song_masters WHERE id = ?").bind(songId).first<LyricsRow>();
  if (row) await replaceSongIndex(db, row.id, row.lyrics, row.lyrics_rich);
  else {
    await db.prepare("DELETE FROM lyrics_search_grams WHERE song_id = ?").bind(songId).run();
    await db.prepare("DELETE FROM lyrics_search_documents WHERE song_id = ?").bind(songId).run();
  }
}

export async function advanceLyricsSearchIndex(db: D1Database, batchSize = INIT_BATCH_SIZE): Promise<LyricsSearchProgress> {
  await ensureLyricsSearchSchema(db);
  let state = await db.prepare("SELECT version, status, last_song_id FROM lyrics_search_state WHERE id = 1").first<{ version: number; status: string; last_song_id: string }>();
  if (!state || state.version !== INDEX_VERSION) {
    await db.prepare("INSERT INTO lyrics_search_state (id, version, status, last_song_id) VALUES (1, ?, 'building', '') ON CONFLICT(id) DO UPDATE SET version = excluded.version, status = excluded.status, last_song_id = excluded.last_song_id")
      .bind(INDEX_VERSION).run();
    state = { version: INDEX_VERSION, status: "building", last_song_id: "" };
  }
  if (state.status === "ready") return "ready";
  const rows = await db.prepare("SELECT id, lyrics, lyrics_rich FROM song_masters WHERE id > ? ORDER BY id ASC LIMIT ?")
    .bind(state.last_song_id, batchSize).all<LyricsRow>();
  for (const row of rows.results) await replaceSongIndex(db, row.id, row.lyrics, row.lyrics_rich);
  if (rows.results.length < batchSize) {
    await db.prepare("UPDATE lyrics_search_state SET status = 'ready' WHERE id = 1").run();
    return "ready";
  }
  await db.prepare("UPDATE lyrics_search_state SET last_song_id = ? WHERE id = 1").bind(rows.results.at(-1)!.id).run();
  return "building";
}

export async function findLyricsSongIds(db: D1Database, rawQuery: string): Promise<string[] | null> {
  const query = rawQuery.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!query) return [];
  if (await advanceLyricsSearchIndex(db) !== "ready") return null;
  let candidates: Set<string> | null = null;
  const required = grams(query);
  for (let offset = 0; offset < required.length; offset += GRAM_QUERY_CHUNK) {
    const chunk = required.slice(offset, offset + GRAM_QUERY_CHUNK);
    const result = await db.prepare(`SELECT song_id FROM lyrics_search_grams WHERE gram IN (${chunk.map(() => "?").join(",")}) GROUP BY song_id HAVING COUNT(DISTINCT gram) = ?`)
      .bind(...chunk, chunk.length).all<{ song_id: string }>();
    const found = new Set(result.results.map((row) => row.song_id));
    const prior: Set<string> | null = candidates;
    candidates = prior === null ? found : new Set<string>([...prior].filter((id: string) => found.has(id)));
    if (candidates.size === 0) return [];
  }
  const exact: string[] = [];
  const ids = [...(candidates ?? [])];
  for (let offset = 0; offset < ids.length; offset += SONG_QUERY_CHUNK) {
    const group = ids.slice(offset, offset + SONG_QUERY_CHUNK);
    const result = await db.prepare(`SELECT song_id FROM lyrics_search_documents WHERE song_id IN (${group.map(() => "?").join(",")}) AND instr(body, ?) > 0`)
      .bind(...group, query).all<{ song_id: string }>();
    exact.push(...result.results.map((row) => row.song_id));
  }
  return exact;
}
