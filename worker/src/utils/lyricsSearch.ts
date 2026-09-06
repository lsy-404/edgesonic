// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseNetEaseLyrics } from "../../../shared/neteaseLyrics";
import { deserializeRich, parseLrcToRich } from "./richLyrics";

const ensured = new WeakSet<D1Database>();
export type LyricsSearchProgress = "ready" | "building";

export function normalizeLyricsSearchQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function readableLyrics(value: string): string[] {
  const lrc = parseNetEaseLyrics(value).split(/\r?\n/u).map((line) => line.trim()).join("\n");
  return (parseLrcToRich(lrc)?.tracks ?? []).flatMap((track) => track.line.map((line) =>
    line.value.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/gu, ""),
  ));
}

export function normalizeLyricsSearchText(lyrics: string | null, rich: string | null): string {
  const values = lyrics ? readableLyrics(lyrics) : [];
  for (const track of deserializeRich(rich)?.tracks ?? []) {
    if (!track || typeof track !== "object") continue;
    for (const line of Array.isArray(track.line) ? track.line : []) {
      if (typeof line?.value === "string") values.push(...readableLyrics(line.value));
    }
    for (const line of Array.isArray(track.cueLine) ? track.cueLine : []) {
      if (typeof line?.value === "string") values.push(...readableLyrics(line.value));
      else if (Array.isArray(line?.cue)) {
        values.push(...readableLyrics(line.cue.map((cue) => typeof cue?.value === "string" ? cue.value : "").join("")));
      }
    }
  }
  return normalizeLyricsSearchQuery(values.join(" "));
}

export function lyricsSearchGrams(text: string): string[] {
  const chars = Array.from(text);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    grams.add(chars[i]);
    if (i + 1 < chars.length) grams.add(chars[i] + chars[i + 1]);
  }
  return [...grams];
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lyrics_search_documents (
    song_id TEXT PRIMARY KEY, body TEXT NOT NULL,
    FOREIGN KEY (song_id) REFERENCES song_masters(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS lyrics_search_grams (
    gram TEXT NOT NULL, song_id TEXT NOT NULL, PRIMARY KEY (gram, song_id),
    FOREIGN KEY (song_id) REFERENCES song_masters(id) ON DELETE CASCADE
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS idx_lyrics_search_grams_song ON lyrics_search_grams(song_id)",
  `CREATE TABLE IF NOT EXISTS lyrics_search_dirty (
    song_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS lyrics_search_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), initialized INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TRIGGER IF NOT EXISTS lyrics_search_song_insert AFTER INSERT ON song_masters BEGIN
    INSERT INTO lyrics_search_dirty(song_id, revision) VALUES (NEW.id, 0)
      ON CONFLICT(song_id) DO UPDATE SET revision = revision + 1;
  END`,
  `CREATE TRIGGER IF NOT EXISTS lyrics_search_song_update AFTER UPDATE OF lyrics, lyrics_rich ON song_masters
    WHEN OLD.lyrics IS NOT NEW.lyrics OR OLD.lyrics_rich IS NOT NEW.lyrics_rich BEGIN
    INSERT INTO lyrics_search_dirty(song_id, revision) VALUES (NEW.id, 0)
      ON CONFLICT(song_id) DO UPDATE SET revision = revision + 1;
  END`,
  `CREATE TRIGGER IF NOT EXISTS lyrics_search_song_delete AFTER DELETE ON song_masters BEGIN
    DELETE FROM lyrics_search_grams WHERE song_id = OLD.id;
    DELETE FROM lyrics_search_documents WHERE song_id = OLD.id;
    DELETE FROM lyrics_search_dirty WHERE song_id = OLD.id;
  END`,
];

async function ensureSchema(db: D1Database): Promise<void> {
  if (ensured.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  ensured.add(db);
}

interface PendingLyrics {
  song_id: string;
  revision: number;
  lyrics: string | null;
  lyrics_rich: string | null;
}

const ELIGIBLE = `WITH eligible AS (
  SELECT item.value AS entry, pending.song_id
  FROM json_each(?) item
  JOIN lyrics_search_dirty pending ON pending.song_id = json_extract(item.value, '$.song_id')
    AND pending.revision = json_extract(item.value, '$.revision')
  JOIN song_masters song ON song.id = pending.song_id
  WHERE song.lyrics IS json_extract(item.value, '$.lyrics')
    AND song.lyrics_rich IS json_extract(item.value, '$.lyrics_rich')
)`;

export async function advanceLyricsSearchIndex(db: D1Database, limit = 12): Promise<LyricsSearchProgress> {
  await ensureSchema(db);
  const state = await db.prepare("SELECT initialized FROM lyrics_search_state WHERE id = 1")
    .first<{ initialized: number }>();
  if (!state?.initialized) {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO lyrics_search_state(id, initialized) VALUES (1, 0)"),
      db.prepare(`INSERT OR IGNORE INTO lyrics_search_dirty(song_id)
        SELECT id FROM song_masters WHERE (SELECT initialized FROM lyrics_search_state WHERE id = 1) = 0`),
      db.prepare("UPDATE lyrics_search_state SET initialized = 1 WHERE id = 1 AND initialized = 0"),
    ]);
  }

  const size = Number.isFinite(limit) ? Math.max(1, Math.min(48, Math.trunc(limit))) : 12;
  const pending = await db.prepare(`SELECT pending.song_id, pending.revision, song.lyrics, song.lyrics_rich
    FROM lyrics_search_dirty pending JOIN song_masters song ON song.id = pending.song_id
    ORDER BY pending.song_id LIMIT ?`).bind(size).all<PendingLyrics>();

  if (pending.results.length) {
    const payload = JSON.stringify(pending.results.map((row) => {
      const body = normalizeLyricsSearchText(row.lyrics, row.lyrics_rich);
      return { ...row, body, grams: lyricsSearchGrams(body) };
    }));
    // The snapshot guard keeps concurrent edits from being replaced by stale index work.
    await db.batch([
      db.prepare(`${ELIGIBLE} DELETE FROM lyrics_search_grams WHERE song_id IN (SELECT song_id FROM eligible)`).bind(payload),
      db.prepare(`${ELIGIBLE} DELETE FROM lyrics_search_documents WHERE song_id IN (SELECT song_id FROM eligible)`).bind(payload),
      db.prepare(`${ELIGIBLE} INSERT INTO lyrics_search_documents(song_id, body)
        SELECT song_id, json_extract(entry, '$.body') FROM eligible
        WHERE json_extract(entry, '$.body') != ''`).bind(payload),
      db.prepare(`${ELIGIBLE} INSERT INTO lyrics_search_grams(gram, song_id)
        SELECT gram.value, entry.song_id FROM eligible entry, json_each(entry.entry, '$.grams') gram`).bind(payload),
      db.prepare(`${ELIGIBLE} DELETE FROM lyrics_search_dirty WHERE song_id IN (SELECT song_id FROM eligible)`).bind(payload),
    ]);
  }
  return await db.prepare("SELECT 1 FROM lyrics_search_dirty LIMIT 1").first() ? "building" : "ready";
}
