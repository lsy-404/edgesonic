import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASK = Path(__file__).resolve().parent
TEST = ROOT / "test" / "atlantis_editions"
BASE_ID = "al-eddee4ba83"
BRACKETED_ID = "al-atlantis-bracketed-edition"
ALT_MIX_ID = "al-atlantis-unbracketed-track3"
GROUP_ID = "group-atlantis-editions"
SENTINEL_ID = "codex-merge-guard-fail"


def load_result(name: str) -> tuple[list[dict], dict]:
    payload = json.loads((TASK / name).read_text(encoding="utf-8"))
    if len(payload) != 1:
        raise ValueError(f"{name}: expected exactly one Wrangler read result")
    result = payload[0]
    if not result.get("success") or not result.get("meta", {}).get("served_by_primary"):
        raise ValueError(f"{name}: read was not served successfully by the primary")
    if result.get("meta", {}).get("rows_written") != 0:
        raise ValueError(f"{name}: production read wrote rows")
    return result["results"], result["meta"]


def sql_text(value: str | None) -> str:
    if value is None:
        return "NULL"
    return f"CAST(X'{value.encode('utf-8').hex()}' AS TEXT)"


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql_number(value: int | None) -> str:
    return "NULL" if value is None else str(value)


tracks, track_meta = load_result("atlantis_primary_track_snapshot.json")
albums, album_meta = load_result("atlantis_album_preflight.json")
group_rows, group_meta = load_result("atlantis_group_preflight.json")
reference_files = [
    "ref_annotations.json",
    "ref_bookmarks.json",
    "ref_playlist_songs.json",
    "ref_share_entries.json",
    "ref_clone_map.json",
    "ref_active_queue.json",
]
reference_data = {}
for name in reference_files:
    rows, meta = load_result(name)
    reference_data[name] = rows
    if meta.get("rows_written") != 0:
        raise ValueError(f"{name}: production read wrote rows")

if len(albums) != 1 or albums[0]["id"] != BASE_ID:
    raise ValueError("expected exactly one current Atlantis album row")
if group_rows:
    raise ValueError("an Atlantis target album already belongs to a display group")
if len(tracks) != 17 or len({row["master_id"] for row in tracks}) != 17:
    raise ValueError("expected 17 distinct current Atlantis masters")
by_suffix = Counter(row["suffix"] for row in tracks)
if by_suffix != Counter({"wav": 8, "flac": 9}):
    raise ValueError(f"unexpected current suffix counts: {by_suffix}")
bracketed = [row for row in tracks if row["title"].endswith(" [Bracketed FLAC edition]")]
alt_mix = [row for row in tracks if row["master_id"] == "alt-atlantis-t03-unbracketed-flac"]
wav = [row for row in tracks if row["suffix"] == "wav"]
if len(bracketed) != 8 or len(alt_mix) != 1 or len(wav) != 8 or alt_mix[0]["track"] != 3:
    raise ValueError("the edition split does not match the reviewed 8/8/1 structure")
if any(row["missing"] != 0 for row in tracks):
    raise ValueError("a target audio instance is marked missing")
if any(row["entry_id"] is None or row["object_id"] != row["entry_object_id"] for row in tracks):
    raise ValueError("a target audio instance lacks its exact object entry")
if any(not row["path"] for row in tracks):
    raise ValueError("a target audio instance lacks its exact source path")

album = albums[0]
expected_values = []
for row in tracks:
    expected_values.append(
        "(" + ",".join(
            [
                sql_string(row["master_id"]),
                sql_string(row["instance_id"]),
                sql_string(row["object_id"]),
                sql_string(row["entry_id"]),
                str(row["track"]),
                sql_number(row["disc"]),
                sql_string(row["suffix"]),
                str(row["size"]),
                str(row["duration"]),
                str(row["missing"]),
                str(row["tag_scanned"]),
                sql_string(row["title"].encode("utf-8").hex().upper()),
                sql_string(row["path"].encode("utf-8").hex().upper()),
                sql_string(row["display_name"].encode("utf-8").hex().upper()),
                sql_string(row["physical_key"]),
            ]
        ) + ")"
    )
expected_cte = (
    "WITH expected(master_id,instance_id,object_id,entry_id,track,disc,suffix,size,duration,missing,tag_scanned,title_hex,path_hex,display_name_hex,physical_key) AS (VALUES\n"
    + ",\n".join(expected_values)
    + ")\n"
)

master_id_list = lambda rows: ",".join(sql_string(row["master_id"]) for row in rows)

guard = f"""(
 (SELECT COUNT(*) FROM albums WHERE id={sql_string(BASE_ID)}
  AND hex(CAST(name AS BLOB))={sql_string(album['name_hex'])}
  AND hex(CAST(sort_name AS BLOB))={sql_string(album['sort_name_hex'])}
  AND year={sql_number(album['year'])}
  AND genre IS NULL
  AND cover_r2_key={sql_string(album['cover_r2_key'])}
  AND song_count={album['song_count']} AND duration={album['duration']} AND size={album['size']}
  AND compilation={album['compilation']} AND created_at={album['created_at']} AND updated_at={album['updated_at']})=1
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(BASE_ID)})=17
 AND (SELECT COUNT(*) FROM expected e
      JOIN song_masters sm ON sm.id=e.master_id
      JOIN song_instances si ON si.id=e.instance_id AND si.master_id=sm.id
      JOIN storage_objects so ON so.id=e.object_id
      JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=si.id
      WHERE sm.album_id={sql_string(BASE_ID)}
       AND sm.track=e.track AND sm.duration=e.duration AND hex(CAST(sm.title AS BLOB))=e.title_hex
       AND ((sm.disc IS NULL AND e.disc IS NULL) OR sm.disc=e.disc)
       AND si.storage_object_id=e.object_id AND lower(si.suffix)=e.suffix AND si.size=e.size
       AND si.missing=e.missing AND si.tag_scanned=e.tag_scanned
       AND so.physical_key=e.physical_key AND so.size=e.size
       AND se.kind='file' AND se.object_id=e.object_id
       AND hex(CAST(se.path AS BLOB))=e.path_hex
       AND hex(CAST(se.display_name AS BLOB))=e.display_name_hex)=17
 AND (SELECT COUNT(*) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(BASE_ID)})=17
 AND (SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(BASE_ID)} AND se.kind='file')=17
 AND (SELECT COUNT(*) FROM storage_objects so JOIN song_instances si ON si.storage_object_id=so.id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(BASE_ID)})=17
 AND (SELECT COUNT(*) FROM albums WHERE id IN ({sql_string(BRACKETED_ID)},{sql_string(ALT_MIX_ID)}))=0
 AND (SELECT COUNT(*) FROM album_display_groups WHERE id={sql_string(GROUP_ID)})=0
 AND (SELECT COUNT(*) FROM album_display_group_members WHERE album_id IN ({sql_string(BASE_ID)},{sql_string(BRACKETED_ID)},{sql_string(ALT_MIX_ID)}))=0
 AND (SELECT COUNT(*) FROM annotations WHERE item_id IN (SELECT id FROM song_masters WHERE album_id={sql_string(BASE_ID)}))=0
 AND (SELECT COUNT(*) FROM bookmarks WHERE song_master_id IN (SELECT id FROM song_masters WHERE album_id={sql_string(BASE_ID)}))=0
 AND (SELECT COUNT(*) FROM playlist_songs WHERE song_master_id IN (SELECT id FROM song_masters WHERE album_id={sql_string(BASE_ID)}))=0
 AND (SELECT COUNT(*) FROM share_entries WHERE song_master_id IN (SELECT id FROM song_masters WHERE album_id={sql_string(BASE_ID)}))=0
 AND (SELECT COUNT(*) FROM clone_id_map WHERE local_id IN (SELECT id FROM song_masters WHERE album_id={sql_string(BASE_ID)}))=16
 AND (SELECT COUNT(*) FROM work_queue WHERE status IN ('queued','claimed') AND EXISTS (SELECT 1 FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(BASE_ID)} AND work_queue.payload LIKE '%'||si.id||'%'))=0
)"""

wav_duration = sum(row["duration"] for row in wav)
wav_size = sum(row["size"] for row in wav)
bracketed_duration = sum(row["duration"] for row in bracketed)
bracketed_size = sum(row["size"] for row in bracketed)
alt_duration = sum(row["duration"] for row in alt_mix)
alt_size = sum(row["size"] for row in alt_mix)

candidate = f"""{expected_cte}
INSERT INTO work_queue(id,task_type,payload,status)
SELECT {sql_string(SENTINEL_ID)},'metadata','{{}}','guard_failed'
WHERE NOT {guard};

INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation)
SELECT {sql_string(BRACKETED_ID)},name || ' [Bracketed FLAC edition]',COALESCE(sort_name,name) || ' bracketed flac edition',year,genre,cover_r2_key,0,0,0,compilation
FROM albums WHERE id={sql_string(BASE_ID)} AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation)
SELECT {sql_string(ALT_MIX_ID)},name || ' [Unbracketed FLAC track 3 mix]',COALESCE(sort_name,name) || ' unbracketed flac track 3 mix',year,genre,cover_r2_key,0,0,0,compilation
FROM albums WHERE id={sql_string(BASE_ID)} AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

UPDATE albums SET name=name || ' [WAV edition]',sort_name=COALESCE(sort_name,name) || ' wav edition',updated_at=unixepoch()
WHERE id={sql_string(BASE_ID)} AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

UPDATE song_masters SET album_id={sql_string(BRACKETED_ID)},updated_at=unixepoch()
WHERE id IN ({master_id_list(bracketed)}) AND album_id={sql_string(BASE_ID)}
 AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

UPDATE song_masters SET album_id={sql_string(ALT_MIX_ID)},updated_at=unixepoch()
WHERE id IN ({master_id_list(alt_mix)}) AND album_id={sql_string(BASE_ID)}
 AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

UPDATE albums SET
 song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(BASE_ID)}),
 duration=COALESCE((SELECT SUM(duration) FROM song_masters WHERE album_id={sql_string(BASE_ID)}),0),
 size=COALESCE((SELECT SUM(si.size) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(BASE_ID)}),0),
 updated_at=unixepoch()
WHERE id={sql_string(BASE_ID)} AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

UPDATE albums SET
 song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(BRACKETED_ID)}),
 duration=COALESCE((SELECT SUM(duration) FROM song_masters WHERE album_id={sql_string(BRACKETED_ID)}),0),
 size=COALESCE((SELECT SUM(si.size) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(BRACKETED_ID)}),0),
 updated_at=unixepoch()
WHERE id={sql_string(BRACKETED_ID)} AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

UPDATE albums SET
 song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(ALT_MIX_ID)}),
 duration=COALESCE((SELECT SUM(duration) FROM song_masters WHERE album_id={sql_string(ALT_MIX_ID)}),0),
 size=COALESCE((SELECT SUM(si.size) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id={sql_string(ALT_MIX_ID)}),0),
 updated_at=unixepoch()
WHERE id={sql_string(ALT_MIX_ID)} AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

INSERT INTO album_display_groups(id,display_name,sort_name)
SELECT {sql_string(GROUP_ID)},CAST(X'E4BA9AE789B9E585B0E89282E696AF2041746C616E746973' AS TEXT),'atlantis'
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

INSERT INTO album_display_group_members(group_id,album_id,sort_order)
SELECT {sql_string(GROUP_ID)},{sql_string(BASE_ID)},0
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});
INSERT INTO album_display_group_members(group_id,album_id,sort_order)
SELECT {sql_string(GROUP_ID)},{sql_string(BRACKETED_ID)},1
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});
INSERT INTO album_display_group_members(group_id,album_id,sort_order)
SELECT {sql_string(GROUP_ID)},{sql_string(ALT_MIX_ID)},2
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)});

{expected_cte}
INSERT INTO work_queue(id,task_type,payload,status)
SELECT {sql_string(SENTINEL_ID)},'metadata','{{}}','guard_failed'
WHERE NOT (
 NOT EXISTS(SELECT 1 FROM work_queue WHERE id={sql_string(SENTINEL_ID)})
 AND (SELECT COUNT(*) FROM album_display_group_members WHERE group_id={sql_string(GROUP_ID)})=3
 AND (SELECT COUNT(*) FROM album_display_groups WHERE id={sql_string(GROUP_ID)} AND display_name=CAST(X'E4BA9AE789B9E585B0E89282E696AF2041746C616E746973' AS TEXT))=1
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(BASE_ID)})=8
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(BRACKETED_ID)})=8
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id={sql_string(ALT_MIX_ID)})=1
 AND (SELECT COUNT(*) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN ({sql_string(BASE_ID)},{sql_string(BRACKETED_ID)},{sql_string(ALT_MIX_ID)}))=17
 AND (SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN ({sql_string(BASE_ID)},{sql_string(BRACKETED_ID)},{sql_string(ALT_MIX_ID)}) AND se.kind='file')=17
 AND (SELECT COUNT(*) FROM storage_objects so JOIN song_instances si ON si.storage_object_id=so.id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN ({sql_string(BASE_ID)},{sql_string(BRACKETED_ID)},{sql_string(ALT_MIX_ID)}))=17
 AND (SELECT COUNT(*) FROM albums WHERE id={sql_string(BASE_ID)} AND song_count=8 AND duration={wav_duration} AND size={wav_size} AND cover_r2_key={sql_string(album['cover_r2_key'])})=1
 AND (SELECT COUNT(*) FROM albums WHERE id={sql_string(BRACKETED_ID)} AND song_count=8 AND duration={bracketed_duration} AND size={bracketed_size} AND cover_r2_key={sql_string(album['cover_r2_key'])})=1
 AND (SELECT COUNT(*) FROM albums WHERE id={sql_string(ALT_MIX_ID)} AND song_count=1 AND duration={alt_duration} AND size={alt_size} AND cover_r2_key={sql_string(album['cover_r2_key'])})=1
 AND (SELECT COUNT(*) FROM clone_id_map WHERE local_id IN (SELECT id FROM song_masters WHERE album_id IN ({sql_string(BASE_ID)},{sql_string(BRACKETED_ID)},{sql_string(ALT_MIX_ID)})))=16
);"""

(TASK / "atlantis_display_group_candidate.sql").write_text(candidate, encoding="utf-8")

# Build a compact Wrangler-local D1 fixture from the exact primary row snapshot.
TEST.mkdir(parents=True, exist_ok=True)
seed = [
    "PRAGMA foreign_keys=ON;",
    "CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_name TEXT,year INTEGER,genre TEXT,cover_r2_key TEXT,song_count INTEGER DEFAULT 0,duration INTEGER DEFAULT 0,size INTEGER DEFAULT 0,compilation INTEGER DEFAULT 0,created_at INTEGER DEFAULT (unixepoch()),updated_at INTEGER DEFAULT (unixepoch()));",
    "CREATE TABLE artists(id TEXT PRIMARY KEY,name TEXT NOT NULL);",
    "CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT NOT NULL,artist_id TEXT NOT NULL,album_artist_id TEXT,title TEXT NOT NULL,sort_title TEXT,track INTEGER,disc INTEGER,duration INTEGER,genre TEXT,compilation INTEGER DEFAULT 0,participants TEXT,lyrics TEXT,lyrics_rich TEXT,created_at INTEGER DEFAULT (unixepoch()),updated_at INTEGER DEFAULT (unixepoch()),FOREIGN KEY(album_id) REFERENCES albums(id),FOREIGN KEY(artist_id) REFERENCES artists(id),FOREIGN KEY(album_artist_id) REFERENCES artists(id));",
    "CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL UNIQUE,suffix TEXT NOT NULL,size INTEGER NOT NULL);",
    "CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT NOT NULL,source_id TEXT NOT NULL,source_type TEXT,suffix TEXT NOT NULL,size INTEGER NOT NULL,missing INTEGER DEFAULT 0,tag_scanned INTEGER DEFAULT 0,storage_object_id TEXT,bit_rate INTEGER,sample_rate INTEGER,bit_depth INTEGER,channels INTEGER,duration INTEGER,FOREIGN KEY(master_id) REFERENCES song_masters(id),FOREIGN KEY(storage_object_id) REFERENCES storage_objects(id));",
    "CREATE TABLE storage_entries(id TEXT PRIMARY KEY,source_id TEXT,parent_id TEXT,path TEXT NOT NULL,display_name TEXT NOT NULL,kind TEXT NOT NULL,object_id TEXT,instance_id TEXT,companion_of TEXT,FOREIGN KEY(object_id) REFERENCES storage_objects(id),FOREIGN KEY(instance_id) REFERENCES song_instances(id));",
    "CREATE TABLE work_queue(id TEXT PRIMARY KEY,task_type TEXT,payload TEXT,status TEXT);",
    "CREATE TABLE annotations(user_id TEXT,item_id TEXT,item_type TEXT);",
    "CREATE TABLE bookmarks(user_id TEXT,song_master_id TEXT);",
    "CREATE TABLE playlist_songs(playlist_id TEXT,song_master_id TEXT,position INTEGER);",
    "CREATE TABLE share_entries(share_id TEXT,song_master_id TEXT,position INTEGER);",
    "CREATE TABLE clone_id_map(source_key TEXT,item_type TEXT,remote_id TEXT,local_id TEXT,PRIMARY KEY(source_key,item_type,remote_id));",
]
name_hex = album["name_hex"]
sort_hex = album["sort_name_hex"]
seed.append(
    "INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at) VALUES ("
    + ",".join([sql_string(BASE_ID), f"CAST(X'{name_hex}' AS TEXT)", f"CAST(X'{sort_hex}' AS TEXT)", str(album["year"]), "NULL", sql_string(album["cover_r2_key"]), str(album["song_count"]), str(album["duration"]), str(album["size"]), str(album["compilation"]), str(album["created_at"]), str(album["updated_at"])])
    + ");"
)
artists = sorted({row["artist_id"] for row in tracks} | {row["album_artist_id"] for row in tracks if row["album_artist_id"]})
for artist in artists:
    seed.append(f"INSERT INTO artists(id,name) VALUES ({sql_string(artist)},{sql_string(artist)});")
for row in tracks:
    seed.append(
        "INSERT INTO song_masters(id,album_id,artist_id,album_artist_id,title,track,disc,duration,genre,compilation,participants,lyrics,lyrics_rich) VALUES ("
        + ",".join([sql_string(row["master_id"]), sql_string(BASE_ID), sql_string(row["artist_id"]), sql_string(row["album_artist_id"] or row["artist_id"]), sql_text(row["title"]), str(row["track"]), sql_number(row["disc"]), str(row["duration"]), sql_text(row["genre"]), str(row["compilation"]), sql_text(row["participants"]), sql_text(row["lyrics"]), sql_text(row["lyrics_rich"])])
        + ");"
    )
    seed.append(
        "INSERT INTO storage_objects(id,physical_key,suffix,size) VALUES ("
        + ",".join([sql_string(row["object_id"]), sql_string(row["physical_key"]), sql_string(row["suffix"]), str(row["size"])])
        + ");"
    )
    seed.append(
        "INSERT INTO song_instances(id,master_id,source_id,source_type,suffix,size,missing,tag_scanned,storage_object_id,bit_rate,sample_rate,bit_depth,channels,duration) VALUES ("
        + ",".join([sql_string(row["instance_id"]), sql_string(row["master_id"]), sql_string(row["source_id"]), sql_string(row["source_type"]), sql_string(row["suffix"]), str(row["size"]), str(row["missing"]), str(row["tag_scanned"]), sql_string(row["object_id"]), sql_number(row["bit_rate"]), sql_number(row["sample_rate"]), sql_number(row["bit_depth"]), sql_number(row["channels"]), str(row["duration"])])
        + ");"
    )
    seed.append(
        "INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id,instance_id) VALUES ("
        + ",".join([sql_string(row["entry_id"]), sql_string(row["source_id"]), sql_string(row["parent_id"]), sql_text(row["path"]), sql_text(row["display_name"]), sql_string(row["kind"]), sql_string(row["entry_object_id"]), sql_string(row["instance_id"])])
        + ");"
    )

clone_rows, _ = load_result("ref_clone_map.json")
for row in clone_rows:
    seed.append(
        "INSERT INTO clone_id_map(source_key,item_type,remote_id,local_id) VALUES ("
        + ",".join(sql_string(row[key]) for key in ["source_key", "item_type", "remote_id", "local_id"])
        + ");"
    )
(TEST / "seed.sql").write_text("\n".join(seed) + "\n", encoding="utf-8")
(TEST / "wrangler.toml").write_text(
    'name = "atlantis-editions-local-rehearsal"\nmain = "../../worker/src/index.ts"\ncompatibility_date = "2025-05-24"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "edgesonic-db"\ndatabase_id = "00000000-0000-0000-0000-000000000001"\n',
    encoding="utf-8",
)
print(f"candidate={TASK / 'atlantis_display_group_candidate.sql'}")
print(f"seed={TEST / 'seed.sql'}")
print(f"masters={len(tracks)} wav={len(wav)} bracketed={len(bracketed)} unbracketed_track3={len(alt_mix)}")
print(f"durations={wav_duration}/{bracketed_duration}/{alt_duration} sizes={wav_size}/{bracketed_size}/{alt_size}")
