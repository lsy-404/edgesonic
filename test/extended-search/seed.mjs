import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;
process.chdir(root);
const config = "test/extended-search/wrangler.jsonc";
const state = "test/extended-search/.wrangler/state";
const scratch = "test/extended-search/.wrangler";
await mkdir(scratch, { recursive: true });

function wrangler(...args) {
  const result = spawnSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", ...args,
    "--config", config, "--local", "--persist-to", state,
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Local fixture command failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  console.log(`Local ${args.slice(0, 3).join(" ")}: ready`);
}

const quote = (value) => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const salt = randomBytes(16);
const digest = pbkdf2Sync("lyrics-preview", salt, 210000, 32, "sha256");
const password = ["pbkdf2-sha256", 210000, salt.toString("base64"), digest.toString("base64")].join("$");
const rich = JSON.stringify({ tracks: [{
  kind: "translation", lang: "zho", synced: false,
  line: [{ value: "星空深处，有我们想去的远方" }], cueLine: [], agents: [],
}] });
const samples = [
  ["lyric-rain", "夜色回声", "[ar:格式字段不应命中]\n[00:01.00]窗外落下细雨\n[00:04.00]We follow the northern light", null],
  ["lyric-title", "细雨", "[00:01.00]这是一首只有标题命中的歌曲", null],
  ["lyric-rich", "远方", null, rich],
  ["lyric-literal", "百分之百", "[00:01.00]100% _ literal\n[00:03.00]Hello WORLD", null],
];

const sampleRate = 8000;
const seconds = 8;
const wav = Buffer.alloc(44 + sampleRate * seconds * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < sampleRate * seconds; i++) {
  wav.writeInt16LE(Math.round(Math.sin(i / sampleRate * 2 * Math.PI * 220) * 700), 44 + i * 2);
}
const audioPath = `${scratch}/sample.wav`;
await writeFile(audioPath, wav);

const sql = [
  `INSERT OR REPLACE INTO users (username, master_password, level, enabled) VALUES ('search-test', ${quote(password)}, 2, 1);`,
  "INSERT OR IGNORE INTO artists (id,name,sort_name) VALUES ('search-artist','示例歌手','示例歌手');",
  "INSERT OR IGNORE INTO albums (id,name,sort_name,song_count) VALUES ('search-album','歌词检索样本','歌词检索样本',4);",
  "INSERT OR IGNORE INTO storage_sources (id,type,name,base_url) VALUES ('r2-local','r2','Local fixtures','');",
  ...samples.flatMap(([id, title, lyrics, lyricsRich], index) => [
    `INSERT OR REPLACE INTO song_masters (id,title,sort_title,album_id,artist_id,duration,lyrics,lyrics_rich,created_at) VALUES (${quote(id)},${quote(title)},${quote(title)},'search-album','search-artist',${seconds},${quote(lyrics)},${quote(lyricsRich)},${1700000000 + index});`,
    `INSERT OR REPLACE INTO song_instances (id,master_id,source_id,storage_uri,suffix,content_type,duration,size,bit_rate,tag_scanned) VALUES (${quote(`${id}-instance`)},${quote(id)},'r2-local','r2://search/sample.wav','wav','audio/wav',${seconds},${wav.length},128,1);`,
  ]),
].join("\n");
const seedPath = `${scratch}/seed.sql`;
await writeFile(seedPath, sql);
wrangler("d1", "execute", "edgesonic-search-local", "--file", "worker/migrations/Schema.sql");
wrangler("d1", "execute", "edgesonic-search-local", "--file", seedPath);
wrangler("r2", "object", "put", "edgesonic-search-local/search/sample.wav", "--file", audioPath);
console.log("Local fixtures ready. Sign in with search-test / lyrics-preview.");
