import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import assert from "node:assert/strict";
import { tagEditRoutes } from "../../worker/src/endpoints/tag/write";
import { parseTags } from "../../worker/src/utils/tags";
function d1(sqlite: DatabaseSync): any {
  function prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values.map((value) => value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value);
        return this;
      },
      async first<T = unknown>() { return (statement.get(...args) ?? null) as T | null; },
      async all<T = unknown>() { return { results: statement.all(...args) as T[], success: true, meta: {} }; },
      async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
    };
  }
  return { prepare, batch: async (items: Array<{ run: () => Promise<unknown> }>) => {
    const results = [];
    for (const item of items) results.push(await item.run());
    return results;
  } };
}

function buildDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, image_r2_key TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT, year INTEGER, genre TEXT, cover_r2_key TEXT, song_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, size INTEGER DEFAULT 0, compilation INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, album_artist_id TEXT, title TEXT NOT NULL, sort_title TEXT, track INTEGER, disc INTEGER, duration INTEGER, genre TEXT, compilation INTEGER DEFAULT 0, participants TEXT, lyrics TEXT, lyrics_rich TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE song_artists (song_id TEXT, artist_id TEXT, position INTEGER DEFAULT 0, PRIMARY KEY(song_id, artist_id));
    CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT, source_type TEXT DEFAULT 'original', storage_uri TEXT, suffix TEXT, content_type TEXT, size INTEGER DEFAULT 0, bit_rate INTEGER DEFAULT 0, duration INTEGER, missing INTEGER DEFAULT 0, tag_scanned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE storage_entries (id TEXT PRIMARY KEY, source_id TEXT, parent_id TEXT, path TEXT, kind TEXT, instance_id TEXT);
    CREATE TABLE storage_sources (id TEXT PRIMARY KEY, base_url TEXT, username TEXT, password TEXT, root_path TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE annotations (user_id TEXT, item_type TEXT, item_id TEXT, starred INTEGER DEFAULT 0, starred_at INTEGER, rating INTEGER, play_count INTEGER DEFAULT 0, play_date INTEGER, PRIMARY KEY(user_id, item_type, item_id));
    CREATE TABLE users (username TEXT PRIMARY KEY, master_password TEXT, level INTEGER, enabled INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE user_permissions (level INTEGER, permission TEXT, enabled INTEGER, max_rph INTEGER, PRIMARY KEY(level, permission));
    INSERT INTO users VALUES ('testuser','x',2,1,0,0);
    INSERT INTO user_permissions VALUES (2,'edit_tags',1,0), (2,'manage_sources',1,0);
    INSERT INTO artists(id,name,sort_name) VALUES ('ar-track-a','Singer A','singer a'), ('ar-track-b','Singer B','singer b');
    INSERT INTO albums(id,name,sort_name) VALUES ('al-old','Old Album','old album');
    INSERT INTO song_masters(id,album_id,artist_id,title,sort_title,track,disc,duration,created_at,updated_at)
      VALUES ('sg-a','al-old','ar-track-a','Same Title','same title',1,1,10,1,1), ('sg-b','al-old','ar-track-b','Same Title','same title',2,1,10,2,2);
    INSERT INTO song_artists(song_id,artist_id,position) VALUES ('sg-a','ar-track-a',0), ('sg-a','ar-track-b',1), ('sg-b','ar-track-b',0);
    INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,content_type,size,bit_rate,duration,created_at,updated_at)
      VALUES ('inst-a','sg-a','r2-local','original','r2://music/a.mp3','mp3','audio/mpeg',4,128,10,1,1), ('inst-b','sg-b','r2-local','original','r2://music/b.mp3','mp3','audio/mpeg',4,128,10,2,2);
  `);
  return db;
}


async function main() {
  const db = buildDb();
  db.exec("UPDATE song_instances SET storage_uri='r2://music/a.wav', suffix='wav', content_type='audio/wav' WHERE id='inst-a'");
  const input = Buffer.alloc(48); input.write('RIFF'); input.writeUInt32LE(40,4); input.write('WAVEfmt ',8); input.writeUInt32LE(16,16); input.writeUInt16LE(1,20); input.writeUInt16LE(1,22); input.writeUInt32LE(8000,24); input.writeUInt32LE(16000,28); input.writeUInt16LE(2,32); input.writeUInt16LE(16,34); input.write('data',36); input.writeUInt32LE(4,40); input.set([1,2,3,4],44);
  let data = Uint8Array.from(input);
  (globalThis as any).FixedLengthStream = class { readable: ReadableStream; writable: WritableStream; constructor() { const t = new TransformStream(); this.readable=t.readable; this.writable=t.writable; } };
  const bucket = {
    async head() { return { size:data.length, etag:'stable', httpMetadata:{contentType:'audio/wav'}, customMetadata:{} }; },
    async get(_key: string, options: any) { const part = data.slice(options.range.offset, options.range.offset+options.range.length); return { body: new Blob([part]).stream(), arrayBuffer: async () => part.buffer }; },
    async put(_key: string, body: ReadableStream) { data = new Uint8Array(await new Response(body).arrayBuffer()); return {}; },
  };
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set('user',{username:'testuser',level:2,enabled:1,password:'x'}); c.set('authMethod','session'); await next(); });
  app.route('/tag',tagEditRoutes);
  const response = await app.fetch(new Request('http://test/tag/batchWrite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['sg-a'],patch:{title:'星尘'}})}), { DB:d1(db), MUSIC_BUCKET:bucket });
  const result:any = await response.json();
  assert.equal(result.results[0].files[0].written,true);
  assert.equal(parseTags(data)?.title,'星尘');
  assert.deepEqual([...data.slice(-4)],[1,2,3,4]);
  console.log('WAV batch endpoint: passed');
}
main().catch(error => { console.error(error); process.exitCode=1; });
