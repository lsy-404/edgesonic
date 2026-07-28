// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Runtime self-heal for the users.nickname column. Schema.sql is the single
// idempotent source of truth (IF NOT EXISTS / INSERT OR IGNORE) and SQLite has
// no "ADD COLUMN IF NOT EXISTS", so a bare ALTER in Schema.sql would fail on
// re-apply. The column therefore lives in the users CREATE TABLE for fresh
// installs and is back-filled here for databases created before it existed.
// Memoized per isolate: at most one ALTER attempt per worker instance.

let ensured = false;
let artistsEnsured = false;

export async function ensureNicknameColumn(env: { DB: D1Database }): Promise<void> {
  if (ensured) return;
  try {
    await env.DB.prepare("ALTER TABLE users ADD COLUMN nickname TEXT").run();
    ensured = true;
  } catch (e) {
    // Column already present → done. Any other error leaves the flag unset so
    // a later request retries rather than silently disabling nicknames.
    if (/duplicate column/i.test(e instanceof Error ? e.message : String(e))) ensured = true;
  }
}

// 0253 — artist biography / image_url / biography_source columns. Same
// idempotent pattern as ensureNicknameColumn: Schema.sql declares them in
// CREATE TABLE for fresh installs; this back-fills existing databases.
export async function ensureArtistScrapeColumns(env: { DB: D1Database }): Promise<void> {
  if (artistsEnsured) return;
  const cols: Array<[string, string]> = [
    ["image_url", "TEXT"],
    ["biography", "TEXT"],
    ["biography_source", "TEXT"],
  ];
  let allDone = true;
  for (const [col, type] of cols) {
    try {
      await env.DB.prepare(`ALTER TABLE artists ADD COLUMN ${col} ${type}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) {
        allDone = false;
      }
    }
  }
  if (allDone) artistsEnsured = true;
}

// 0259 — song_masters.lyrics_rich column. Stores the JSON-serialized
// RichLyrics payload (cueLine/cue/agents) produced from TTML/KRC/enhanced
// LRC sidecars or NetEase klyric. NULL when only line-level LRC is
// available; the getLyricsBySongId endpoint degrades to lyrics then.
let richLyricsEnsured = false;
export async function ensureRichLyricsColumn(env: { DB: D1Database }): Promise<void> {
  if (richLyricsEnsured) return;
  try {
    await env.DB.prepare("ALTER TABLE song_masters ADD COLUMN lyrics_rich TEXT").run();
    richLyricsEnsured = true;
  } catch (e) {
    if (/duplicate column/i.test(e instanceof Error ? e.message : String(e))) richLyricsEnsured = true;
  }
}

// users.email / users.email_verified for self-service password reset
// and email registration. Same idempotent self-heal pattern: both columns
// are declared in Schema.sql's CREATE TABLE for fresh installs; this
// back-fills databases created before they existed. The partial unique
// index is safe to (re-)run unconditionally since CREATE INDEX supports
// IF NOT EXISTS natively.
let emailColumnsEnsured = false;
export async function ensureEmailColumns(env: { DB: D1Database }): Promise<void> {
  if (emailColumnsEnsured) return;
  const alters = [
    "ALTER TABLE users ADD COLUMN email TEXT",
    "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0",
  ];
  let allDone = true;
  for (const sql of alters) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) allDone = false;
    }
  }
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL"
  ).run();
  if (allDone) emailColumnsEnsured = true;
}

// Account activation: users.activation_status / users.activated_until plus
// the invite_codes / invite_redemptions tables and the feature/permission
// rows the endpoints read. Same idempotent self-heal pattern as above;
// Schema.sql declares everything for fresh installs.
let activationEnsured = false;
export async function ensureActivationSchema(env: { DB: D1Database }): Promise<void> {
  if (activationEnsured) return;
  const alters = [
    "ALTER TABLE users ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'permanent'",
    "ALTER TABLE users ADD COLUMN activated_until INTEGER",
    // Long-lived client credentials carry the activation horizon they were
    // issued under; NULL means no ceiling (permanent activation).
    "ALTER TABLE subsonic_credentials ADD COLUMN expires_at INTEGER",
    // Per-song artwork; NULL means the song shows its album's cover.
    "ALTER TABLE song_masters ADD COLUMN cover_r2_key TEXT",
  ];
  let allDone = true;
  for (const sql of alters) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) allDone = false;
    }
  }
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('window', 'duration', 'permanent')),
      window_start INTEGER,
      window_end INTEGER,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS invite_redemptions (
      code TEXT NOT NULL,
      username TEXT NOT NULL,
      redeemed_at INTEGER NOT NULL,
      PRIMARY KEY (code, username)
    )`
  ).run();
  // Seed the rows /features/update and the permission matrix UPDATE against
  // (both only UPDATE existing rows).
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO features (key, value, description) VALUES ('enable_activation', 0, '账户激活体系总开关（关闭时所有账号视为永久激活）')"
    ).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO feature_strings (key, value, description, updated_at) VALUES ('registration_gate_mode', 'all', '注册创建选项模式：all=需满足全部已启用选项，any=任一即可', unixepoch())"
    ).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES (3, 'manage_activation', 1, 0), (2, 'manage_activation', 0, 0), (1, 'manage_activation', 0, 0), (0, 'manage_activation', 0, 0)"
    ).run();
    // Referenced by the shares and now-playing endpoints but never seeded, so
    // it could not be delegated below super admin until now.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user_permissions (level, permission, enabled, max_rph) VALUES (3, 'view_all_users_items', 1, 0), (2, 'view_all_users_items', 0, 0), (1, 'view_all_users_items', 0, 0), (0, 'view_all_users_items', 0, 0)"
    ).run();
  } catch {
    // features / user_permissions tables may not exist in minimal test schemas.
  }
  if (allDone) activationEnsured = true;
}

// storage_sources.cache_tier (per-source hot-cache tier selector) and
// song_instances.last_accessed_at (LRU key for evictForRoom). Same idempotent
// self-heal pattern: both columns are declared in Schema.sql's CREATE TABLE
// for fresh installs; this back-fills databases created before these columns existed.
let cacheTierColumnsEnsured = false;
export async function ensureCacheTierColumns(env: { DB: D1Database }): Promise<void> {
  if (cacheTierColumnsEnsured) return;
  const alters: string[] = [
    "ALTER TABLE storage_sources ADD COLUMN cache_tier TEXT NOT NULL DEFAULT 'off' CHECK (cache_tier IN ('off', 'standard', 'extended'))",
    "ALTER TABLE song_instances ADD COLUMN last_accessed_at INTEGER",
  ];
  let allDone = true;
  for (const sql of alters) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) allDone = false;
    }
  }
  if (allDone) cacheTierColumnsEnsured = true;
}
