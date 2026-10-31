const PREFIX = "mcp:oauth:";
const SWEEP_KEY = "mcp:oauth-sweep";
const REVOKED_PREFIX = "mcp:oauth-revoked:";
function grantIdentity(key: string): string | null {
  const parts = key.split(":");
  if (parts[0] === "grant" && parts.length === 3) return `${parts[1]}:${parts[2]}`;
  if (parts[0] === "token" && parts.length === 4) return `${parts[1]}:${parts[2]}`;
  return null;
}
type Entry = { value: string; expiration?: number; metadata?: unknown };

export class OAuthStore {
  private grants = new Map<string, string>();
  constructor(private db: D1Database) {}

  async get(key: string, options?: { type?: string } | string): Promise<any> {
    const fullKey = PREFIX + key;
    const grant = grantIdentity(key);
    const row = grant
      ? await this.db.prepare("SELECT value FROM kv_store WHERE key = ? AND NOT EXISTS (SELECT 1 FROM kv_store WHERE key = ?)").bind(fullKey, REVOKED_PREFIX + grant).first<{ value: string }>()
      : await this.db.prepare("SELECT value FROM kv_store WHERE key = ?").bind(fullKey).first<{ value: string }>();
    if (!row) return null;
    const entry: Entry = JSON.parse(row.value);
    if (entry.expiration !== undefined && entry.expiration <= Date.now() / 1000) {
      await this.db.prepare("DELETE FROM kv_store WHERE key = ? AND value = ?").bind(fullKey, row.value).run();
      return null;
    }
    if (key.startsWith("grant:") && grant) this.grants.set(key, row.value);
    return (typeof options === "string" ? options : options?.type) === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expiration?: number; expirationTtl?: number; metadata?: unknown }): Promise<void> {
    const expiration = options?.expirationTtl !== undefined ? Math.floor(Date.now() / 1000) + options.expirationTtl : options?.expiration;
    const entry: Entry = { value, expiration, metadata: options?.metadata };
    const fullKey = PREFIX + key;
    const encoded = JSON.stringify(entry);
    const grant = grantIdentity(key);
    if (grant && key.startsWith("grant:")) {
      const previous = this.grants.get(key);
      const result = previous === undefined
        ? await this.db.prepare("INSERT INTO kv_store (key, value, updated_at) SELECT ?, ?, unixepoch() WHERE NOT EXISTS (SELECT 1 FROM kv_store WHERE key = ?) ON CONFLICT(key) DO NOTHING")
          .bind(fullKey, encoded, REVOKED_PREFIX + grant).run()
        : await this.db.prepare("UPDATE kv_store SET value = ?, updated_at = unixepoch() WHERE key = ? AND value = ? AND NOT EXISTS (SELECT 1 FROM kv_store WHERE key = ?)")
          .bind(encoded, fullKey, previous, REVOKED_PREFIX + grant).run();
      if (result.meta.changes !== 1) throw new Error("OAuth grant changed or was revoked");
      this.grants.set(key, encoded);
    } else if (grant) {
      const result = await this.db.prepare("INSERT INTO kv_store (key, value, updated_at) SELECT ?, ?, unixepoch() WHERE NOT EXISTS (SELECT 1 FROM kv_store WHERE key = ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(fullKey, encoded, REVOKED_PREFIX + grant).run();
      if (result.meta.changes !== 1) throw new Error("OAuth grant was revoked");
    } else {
      await this.db.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(fullKey, encoded).run();
    }
    if (Math.random() < 1 / 128) await this.sweep();
  }

  async delete(key: string): Promise<void> {
    const grant = grantIdentity(key);
    if (grant && key.startsWith("grant:")) {
      await this.db.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, '1', unixepoch()) ON CONFLICT(key) DO NOTHING")
        .bind(REVOKED_PREFIX + grant).run();
    }
    await this.db.prepare("DELETE FROM kv_store WHERE key = ?").bind(PREFIX + key).run();
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const prefix = PREFIX + (options.prefix ?? "");
    const after = options.cursor ? decodeURIComponent(options.cursor) : "";
    if (after && !after.startsWith(prefix)) throw new Error("Invalid OAuth cursor");
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 1000));
    const rows = await this.db.prepare("SELECT key, value FROM kv_store WHERE key >= ? AND key < ? AND key > ? AND (json_extract(value, '$.expiration') IS NULL OR json_extract(value, '$.expiration') > ?) ORDER BY key LIMIT ?")
      .bind(prefix, prefix + "\uffff", after, Math.floor(Date.now() / 1000), limit + 1).all<{ key: string; value: string }>();
    const page = rows.results.slice(0, limit);
    const keys = page.map(row => {
      const entry: Entry = JSON.parse(row.value);
      return { name: row.key.slice(PREFIX.length), ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }), ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }) };
    });
    const complete = rows.results.length <= limit;
    return { keys, list_complete: complete, ...(complete ? {} : { cursor: encodeURIComponent(page[page.length - 1].key) }), cacheStatus: null };
  }

  private async sweep(): Promise<void> {
    const cursor = await this.db.prepare("SELECT value FROM kv_store WHERE key = ?").bind(SWEEP_KEY).first<{ value: string }>();
    const after = cursor?.value?.startsWith(PREFIX) ? cursor.value : PREFIX;
    const rows = await this.db.prepare("SELECT key FROM kv_store WHERE key > ? AND key < ? ORDER BY key LIMIT 100").bind(after, PREFIX + "\uffff").all<{ key: string }>();
    const last = rows.results.at(-1)?.key;
    if (last) await this.db.prepare("DELETE FROM kv_store WHERE key > ? AND key <= ? AND json_extract(value, '$.expiration') IS NOT NULL AND json_extract(value, '$.expiration') <= ?")
      .bind(after, last, Math.floor(Date.now() / 1000)).run();
    await this.db.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(SWEEP_KEY, rows.results.length === 100 ? last : PREFIX).run();
  }
}
