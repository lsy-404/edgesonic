import json
from pathlib import Path

root = Path(__file__).parent
snapshot = json.loads((root / "zhulan_primary_snapshot.json").read_text(encoding="utf-8"))
rows = snapshot["rows"]
pending = snapshot["pending"]
if len(rows) != 28:
    raise SystemExit(f"expected 28 snapshot rows, got {len(rows)}")

fields = [
    "master_id", "album_id", "artist_id", "album_artist_id", "title", "track", "disc", "master_duration",
    "has_lyrics", "has_rich_lyrics", "master_cover", "instance_id", "source_id", "source_type", "storage_uri",
    "suffix", "instance_size", "instance_duration", "missing", "tag_scanned", "storage_object_id", "source_etag",
    "entry_id", "parent_id", "path", "display_name", "kind", "companion_of", "object_id", "physical_key",
    "legacy_key", "object_size", "object_etag", "track_no",
]
def lit(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"

records = []
for row in rows:
    values = []
    for field in fields:
        if field == "has_lyrics":
            value = int(row["lyrics"] is not None)
        elif field == "has_rich_lyrics":
            value = int(row["lyrics_rich"] is not None)
        elif field == "master_cover":
            value = row["cover_r2_key"]
        elif field == "track_no":
            value = int(row["title"][:2])
        else:
            value = row[field]
        values.append(lit(value))
    records.append("(" + ",".join(values) + ")")

col_list = ",".join(fields)
values_sql = ",\n ".join(records)
track_sql = ",\n ".join(f"({lit(r['master_id'])},{int(r['title'][:2])})" for r in rows)
physical_comparisons = " AND ".join(f"{actual} IS c.{expected}" for actual, expected in [
    ("sm.album_id", "album_id"), ("sm.artist_id", "artist_id"), ("sm.album_artist_id", "album_artist_id"),
    ("sm.title", "title"), ("sm.track", "track"), ("sm.disc", "disc"), ("sm.duration", "master_duration"),
    ("sm.cover_r2_key", "master_cover"), ("si.id", "instance_id"), ("si.source_id", "source_id"),
    ("si.source_type", "source_type"), ("si.storage_uri", "storage_uri"), ("si.suffix", "suffix"),
    ("si.size", "instance_size"), ("si.duration", "instance_duration"), ("si.missing", "missing"),
    ("si.tag_scanned", "tag_scanned"), ("si.storage_object_id", "storage_object_id"), ("si.source_etag", "source_etag"),
    ("se.id", "entry_id"), ("se.parent_id", "parent_id"), ("se.path", "path"),
    ("se.display_name", "display_name"), ("se.kind", "kind"), ("se.companion_of", "companion_of"),
    ("se.object_id", "object_id"), ("so.physical_key", "physical_key"), ("so.legacy_key", "legacy_key"),
    ("so.size", "object_size"), ("so.etag", "object_etag"), ("so.suffix", "suffix"),
])
physical_comparisons += " AND (sm.lyrics IS NULL)=(c.has_lyrics=0) AND (sm.lyrics_rich IS NULL)=(c.has_rich_lyrics=0)"

sql = f'''WITH c({col_list}) AS (VALUES
 {values_sql}
)
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'zhulan-guard-failed','metadata','{{}}','guard_failed',unixepoch()
WHERE NOT (
  (SELECT COUNT(*) FROM c)=28
  AND (SELECT COUNT(DISTINCT track_no) FROM c)=28
  AND (SELECT MIN(track_no) FROM c)=1
  AND (SELECT MAX(track_no) FROM c)=28
  AND (SELECT COUNT(*) FROM albums WHERE id='pending-uploads' AND song_count={pending['song_count']} AND duration={pending['duration']} AND size={pending['size']})=1
  AND (SELECT COUNT(*) FROM albums a WHERE a.id='pending-uploads'
       AND a.song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=a.id)
       AND a.duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=a.id)
       AND a.size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=a.id))=1
  AND (SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id
       JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id
       JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id
       JOIN storage_objects so ON so.id=c.storage_object_id
       WHERE {physical_comparisons})=28
  AND (SELECT COUNT(*) FROM storage_entries WHERE path='蔗蓝的创作集1.0-蔗蓝（wav）' OR path LIKE '蔗蓝的创作集1.0-蔗蓝（wav）/%')=30
  AND EXISTS(SELECT 1 FROM storage_entries WHERE id='se-e43af23755444b1aa56d4501c7ba77d4' AND source_id='r2-local' AND parent_id IS NULL AND path='蔗蓝的创作集1.0-蔗蓝（wav）' AND display_name='蔗蓝的创作集1.0-蔗蓝（wav）' AND kind='folder' AND object_id IS NULL AND instance_id IS NULL AND companion_of IS NULL)
  AND EXISTS(SELECT 1 FROM storage_entries se JOIN storage_objects so ON so.id=se.object_id WHERE se.id='se-9c7a6e8fe38949a6b6a231dafc7ccad1' AND se.source_id='r2-local' AND se.parent_id='se-e43af23755444b1aa56d4501c7ba77d4' AND se.object_id='obj_568cc33144589d95' AND se.path='蔗蓝的创作集1.0-蔗蓝（wav）/蔗蓝的创作集1.0.cue' AND se.display_name='蔗蓝的创作集1.0.cue' AND se.kind='file' AND se.instance_id IS NULL AND se.companion_of IS NULL AND so.physical_key='objects/obj_568cc33144589d95.cue' AND so.legacy_key IS NULL AND so.suffix='cue' AND so.size=4649 AND so.etag IS NULL)
  AND NOT EXISTS(SELECT 1 FROM artists WHERE id='ar-abdf58605e' OR name='蔗蓝')
  AND NOT EXISTS(SELECT 1 FROM albums WHERE id='al-fe198b18b1' OR name='蔗蓝的创作集1.0')
);
INSERT INTO artists(id,name,sort_name,created_at,updated_at) VALUES('ar-abdf58605e','蔗蓝','蔗蓝',unixepoch(),unixepoch());
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'zhulan-guard-failed','metadata','{{}}','guard_failed',unixepoch() WHERE changes()!=1;
INSERT INTO albums(id,name,sort_name,song_count,duration,size,compilation,created_at,updated_at) VALUES('al-fe198b18b1','蔗蓝的创作集1.0','蔗蓝的创作集1.0',0,0,0,0,unixepoch(),unixepoch());
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'zhulan-guard-failed','metadata','{{}}','guard_failed',unixepoch() WHERE changes()!=1;
WITH c(master_id,track_no) AS (VALUES
 {track_sql}
)
UPDATE song_masters SET album_id='al-fe198b18b1',artist_id='ar-abdf58605e',album_artist_id='ar-abdf58605e',track=(SELECT track_no FROM c WHERE c.master_id=song_masters.id),disc=1,updated_at=unixepoch()
WHERE id IN(SELECT master_id FROM c) AND album_id='pending-uploads' AND artist_id='unknown-artist' AND track IS NULL AND disc IS NULL;
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'zhulan-guard-failed','metadata','{{}}','guard_failed',unixepoch() WHERE changes()!=28;
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN('pending-uploads','al-fe198b18b1');
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'zhulan-guard-failed','metadata','{{}}','guard_failed',unixepoch()
WHERE EXISTS(SELECT 1 FROM work_queue WHERE id='zhulan-force-late-failure');
'''
with (root / "apply_zhulan_collection.sql").open("w", encoding="utf-8", newline="\n") as stream:
    stream.write(sql)
preflight = f'''WITH c({col_list}) AS (VALUES
 {values_sql}
), exact AS (
  SELECT c.master_id,c.track_no
  FROM c JOIN song_masters sm ON sm.id=c.master_id
  JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id
  JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id
  JOIN storage_objects so ON so.id=c.storage_object_id
  WHERE {physical_comparisons}
)
SELECT
  (SELECT COUNT(*) FROM exact) AS exact_rows,
  (SELECT COUNT(DISTINCT track_no) FROM exact) AS distinct_tracks,
  (SELECT MIN(track_no) FROM exact) AS first_track,
  (SELECT MAX(track_no) FROM exact) AS last_track,
  a.song_count AS pending_count,a.duration AS pending_duration,a.size AS pending_size,
  (SELECT COUNT(*) FROM song_masters WHERE album_id=a.id) AS computed_count,
  (SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=a.id) AS computed_duration,
  (SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=a.id) AS computed_size,
  (SELECT COUNT(*) FROM storage_entries WHERE path='蔗蓝的创作集1.0-蔗蓝（wav）' OR path LIKE '蔗蓝的创作集1.0-蔗蓝（wav）/%') AS tree_entries,
  (SELECT COUNT(*) FROM storage_entries se JOIN storage_objects so ON so.id=se.object_id WHERE se.id='se-9c7a6e8fe38949a6b6a231dafc7ccad1' AND se.object_id='obj_568cc33144589d95' AND so.physical_key='objects/obj_568cc33144589d95.cue' AND so.legacy_key IS NULL AND so.suffix='cue' AND so.size=4649 AND so.etag IS NULL) AS cue_object_match,
  (SELECT COUNT(*) FROM artists WHERE id='ar-abdf58605e' OR name='蔗蓝') AS artist_conflicts,
  (SELECT COUNT(*) FROM albums WHERE id='al-fe198b18b1' OR name='蔗蓝的创作集1.0') AS album_conflicts
FROM albums a WHERE a.id='pending-uploads';
'''
with (root / "production_preflight_zhulan.sql").open("w", encoding="utf-8", newline="\n") as stream:
    stream.write(preflight)
