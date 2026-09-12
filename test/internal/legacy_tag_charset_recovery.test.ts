import { parseTags } from "../../worker/src/utils/tags";
import { recoverMetadataFromStoragePath } from "../../worker/src/utils/storageMetadata";
import { mapAlbum, mapSong } from "../../worker/src/types/subsonic";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

function ascii(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0));
}
function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function infoChunk(id: string, value: number[]): number[] {
  const padded = value.length % 2 === 0 ? value : [...value, 0];
  return [...ascii(id), ...le32(value.length), ...padded];
}
function riffInfo(fields: Array<[string, number[]]>): Uint8Array {
  const info = fields.flatMap(([id, value]) => infoChunk(id, value));
  const list = [...ascii("INFO"), ...info];
  const body = [...ascii("WAVE"), ...ascii("LIST"), ...le32(list.length), ...list];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

const wav = riffInfo([
  ["IART", [0x3f, 0xa5, 0xbf, 0x3f, 0]],
  ["INAM", [0xa4, 0x6a, 0x3f, 0xba, 0x71, ...ascii("20XX"), 0]],
  ["IPRD", [0x3f, 0x3f, 0xae, 0xc4, 0x3f, ...ascii("Conformity"), 0]],
]);
const parsed = parseTags(wav);

assert(parsed?.title === "大?歌20XX", "RIFF INFO chooses Big5 over invalid UTF-8 or GB18030 private-use output");
assert(parsed?.album === "??效?Conformity", "RIFF INFO keeps the readable Big5 portion of a lossy legacy album tag");

const repaired = recoverMetadataFromStoragePath(
  "r2://music/专辑/从众效应Conformity（wav）/wav/08 大风歌20XX.wav",
  parsed || {},
);
assert(repaired.title === "大风歌20XX", "path fallback restores the readable track title");
assert(repaired.album === "从众效应Conformity", "path fallback restores and normalizes the album name");
assert(repaired.artist === "Unknown Artist" && repaired.albumArtist === "Unknown Artist", "lossy artist text becomes a stable grouping identity");

const uri = "r2://music/专辑/从众效应Conformity（wav）/wav/08 大风歌20XX.wav";
const albumResponse = mapAlbum({
  id: "al-damaged", name: "??效?Conformity", sort_name: null, year: null, genre: null,
  cover_r2_key: null, song_count: 1, duration: 0, size: 0, compilation: 0, created_at: 0, updated_at: 0,
}, "?正?", undefined, uri);
assert(albumResponse.name === "从众效应Conformity" && albumResponse.artist === "Unknown Artist", "album API response repairs the currently stored display fields");

const songResponse = mapSong({
  id: "sm-damaged", album_id: "al-damaged", artist_id: "ar-damaged", album_artist_id: null,
  title: "大?歌20XX", sort_title: null, track: 8, disc: null, duration: null, genre: null,
  compilation: 0, participants: null, lyrics: null, lyrics_rich: null, created_at: 0, updated_at: 0,
  artist_name: "?正?", album_name: "??效?Conformity", album_artist_name: null,
  inst_storage_uri: uri,
}, "al-damaged");
assert(songResponse.title === "大风歌20XX" && songResponse.album === "从众效应Conformity" && songResponse.artist === "Unknown Artist", "song API response repairs the detail view without mutating source data");

const questionOnlyAlbum = mapAlbum({
  id: "al-question", name: "？？xx? Conformity", sort_name: null, year: null, genre: null,
  cover_r2_key: null, song_count: 1, duration: 0, size: 0, compilation: 0, created_at: 0, updated_at: 0,
}, "Unknown Artist", undefined, "r2://从众效应Conformity（wav）/wav/08 大风歌20XX.wav");
assert(questionOnlyAlbum.name === "从众效应Conformity", "repeated full-width or ASCII question marks recover from an R2 root album path");

const clean = recoverMetadataFromStoragePath(
  "r2://music/专辑/别名（wav）/01 不应替换.wav",
  { title: "正确标题", artist: "正确歌手", album: "正确专辑" },
);
assert(clean.title === "正确标题" && clean.artist === "正确歌手" && clean.album === "正确专辑", "clean metadata is never overridden by its storage path");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
