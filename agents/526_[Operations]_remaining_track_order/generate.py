import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SOURCE = ROOT / "agents/513_[Operations]_pending_upload_backfill/candidate_map_safe.json"
PATTERNS = {
    "FM404": re.compile(r"^([1-9])(?=\D)"),
    "Stay": re.compile(r"^(\d{2})(?=\D)"),
    "低语者": re.compile(r"^(\d{2})(?=\D)"),
    "如期归还": re.compile(r"^Sec\.(\d+) "),
}


def quote(value):
    return "'" + value.replace("'", "''") + "'"


source = json.loads(SOURCE.read_text(encoding="utf-8"))
selected = []
for name, pattern in PATTERNS.items():
    album = [row for row in source if row["album_name"] == name]
    assert album
    assert len({row["target_album_id"] for row in album}) == 1
    assert len({(row["source_id"], row["parent_id"]) for row in album}) == 1
    tracks = []
    for row in album:
        match = pattern.match(row["display_name"])
        assert match, (name, row["display_name"])
        track = int(match.group(1))
        assert row["track_snapshot"] is None and row["disc_snapshot"] is None
        tracks.append(track)
        selected.append((row, track))
    assert sorted(tracks) == list(range(1, len(album) + 1)), name

assert len(selected) == 36
assert len({row["master_id"] for row, _ in selected}) == 36
selected.sort(key=lambda item: (item[0]["album_name"], item[1]))
columns = "master_id,album_id,filename_track,instance_id,entry_id,source_id,parent_id,path,display_name,object_id,title"
values = ",\n".join(
    "(" + ",".join(
        quote(value) if isinstance(value, str) else str(value)
        for value in (
            row["master_id"], row["target_album_id"], track,
            row["instance_id"], row["entry_id"], row["source_id"],
            row["parent_id"], row["path"], row["display_name"],
            row["storage_object_id"], row["title_snapshot"],
        )
    ) + ")"
    for row, track in selected
)
cte = f"WITH expected({columns}) AS (VALUES\n{values}\n)\n"
source_match = """EXISTS (
  SELECT 1 FROM song_instances si JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file'
  WHERE si.id=e.instance_id AND si.master_id=sm.id AND si.source_id=e.source_id
    AND si.storage_object_id=e.object_id AND se.id=e.entry_id AND se.source_id=e.source_id
    AND se.parent_id=e.parent_id AND se.path=e.path AND se.display_name=e.display_name
    AND se.object_id=e.object_id
)"""
common = f"sm.album_id=e.album_id AND sm.title=e.title AND {source_match}"
before = f"sm.track IS NULL AND sm.disc IS NULL AND {common}"
after = f"sm.track=e.filename_track AND sm.disc=1 AND {common}"
guard = lambda condition: f"(SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id WHERE {condition})=(SELECT COUNT(*) FROM expected)"

apply = cte + f"UPDATE song_masters SET track=(SELECT filename_track FROM expected e WHERE e.master_id=song_masters.id),disc=1,updated_at=unixepoch() WHERE id IN (SELECT master_id FROM expected) AND {guard(before)};\n"
rollback = cte + f"UPDATE song_masters SET track=NULL,disc=NULL,updated_at=unixepoch() WHERE id IN (SELECT master_id FROM expected) AND {guard(after)};\n"
preflight = cte + f"SELECT (SELECT COUNT(*) FROM expected) AS expected_count,(SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id WHERE {before}) AS exact_ready;\n"
postflight = cte + f"SELECT (SELECT COUNT(*) FROM expected) AS expected_count,(SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id WHERE {after}) AS exact_applied;\n"

for filename, data in (("apply.sql", apply), ("rollback.sql", rollback), ("preflight.sql", preflight), ("postflight.sql", postflight)):
    (HERE / filename).write_text(data, encoding="utf-8")
(HERE / "scope.json").write_text(json.dumps([
    {"album_name": row["album_name"], "master_id": row["master_id"], "track": track,
     "path": row["path"], "instance_id": row["instance_id"],
     "entry_id": row["entry_id"], "object_id": row["storage_object_id"]}
    for row, track in selected
], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
