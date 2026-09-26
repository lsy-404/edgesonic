"""Build the reviewed D1-only track-order candidate and exact source guards."""
from __future__ import annotations
import json, re, sys
from collections import defaultdict
from pathlib import Path

NUMBERED_NAME = re.compile(r"^\s*(?:Track\s+)?0*(\d{1,2})(?=\s|[._-])", re.I)
FIELDS = ("master_id", "target_album_id", "filename_track", "instance_id", "entry_id", "source_id", "parent_id", "path", "display_name", "storage_object_id")

def sql(value: str | int) -> str:
    if isinstance(value, int):
        return str(value)
    return "||char(35)||".join("'" + part.replace("'", "''") + "'" for part in value.split("#"))

def values(rows: list[dict]) -> str:
    return ",\n".join("  (" + ", ".join(sql(row[field]) for field in FIELDS) + ")" for row in rows)

def cte(rows: list[dict]) -> str:
    return "WITH expected(" + ", ".join(FIELDS) + ") AS (VALUES\n" + values(rows) + "\n)"

def source_guard(alias: str = "sm", nulls: bool = True) -> str:
    metadata = f"{alias}.track IS NULL AND {alias}.disc IS NULL" if nulls else f"{alias}.track=e.filename_track AND {alias}.disc=1"
    return f"""{alias}.album_id=e.target_album_id AND {metadata}
AND EXISTS (SELECT 1 FROM song_instances si JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file'
            WHERE si.id=e.instance_id AND si.master_id={alias}.id AND si.source_id=e.source_id
              AND si.storage_object_id=e.storage_object_id AND se.id=e.entry_id AND se.source_id=e.source_id
              AND se.parent_id=e.parent_id AND se.path=e.path AND se.display_name=e.display_name)"""

def write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")

def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2).replace("#", "\\u0023") + "\n"

def main(source: Path, output: Path) -> None:
    rows = json.loads(source.read_text(encoding="utf-8"))
    all_groups, numbered = defaultdict(list), defaultdict(list)
    for row in rows:
        all_groups[row["target_album_id"]].append(row)
        if match := NUMBERED_NAME.match(row["display_name"]):
            numbered[row["target_album_id"]].append({**row, "filename_track": int(match.group(1))})
    selected = []
    for album_id, members in numbered.items():
        indices = [row["filename_track"] for row in members]
        parents = {(row["source_id"], row["parent_id"]) for row in members}
        if len(members) == len(all_groups[album_id]) and len(indices) == len(set(indices)) and len(parents) == 1:
            selected.extend(members)
    selected.sort(key=lambda row: (row["target_album_id"], row["filename_track"], row["master_id"]))
    albums = {row["target_album_id"] for row in selected}
    if len(selected) != 243 or len(albums) != 25:
        raise SystemExit(f"unexpected scope: {len(selected)} masters / {len(albums)} groups")
    output.mkdir(parents=True, exist_ok=True)
    snapshot = [{field: row[field] for field in FIELDS} for row in selected]
    write(output / "snapshot_candidate.json", json_text(snapshot))
    layout = [{"album_id": album, "members": len(members), "source_parent": {"source_id": members[0]["source_id"], "parent_id": members[0]["parent_id"]}, "unique_filename_indices": sorted(row["filename_track"] for row in members)} for album in sorted(albums) if (members := [row for row in selected if row["target_album_id"] == album])]
    write(output / "source_layout_summary.json", json_text(layout))
    all_cte, guard = cte(selected), source_guard()
    write(output / "primary_preflight.sql", f"""{all_cte}, candidate AS (
 SELECT e.master_id, e.target_album_id, e.filename_track, sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc, {guard} AS exact_source_match FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id
)
SELECT (SELECT COUNT(*) FROM expected) AS expected_masters, (SELECT COUNT(DISTINCT target_album_id) FROM expected) AS expected_albums, (SELECT COUNT(*) FROM candidate WHERE exact_source_match) AS exact_source_matches, (SELECT COUNT(*) FROM candidate WHERE NOT exact_source_match) AS stale_or_conflicting, (SELECT COUNT(*) FROM (SELECT target_album_id, filename_track, COUNT(*) n FROM expected GROUP BY target_album_id, filename_track HAVING n<>1)) AS reused_index_groups, (SELECT COUNT(*) FROM (SELECT target_album_id, source_id, parent_id, COUNT(*) n FROM expected GROUP BY target_album_id, source_id, parent_id) x WHERE (SELECT COUNT(*) FROM expected e2 WHERE e2.target_album_id=x.target_album_id)<>x.n) AS multi_parent_groups;
""")
    for offset in range(0, len(selected), 10):
        chunk = selected[offset:offset+10]
        write(output / f"primary_preflight_{offset // 10 + 1:02d}.sql", f"""{cte(chunk)}
SELECT e.master_id, e.target_album_id AS expected_album_id, e.filename_track, e.instance_id, e.entry_id, e.source_id, e.parent_id, e.path AS expected_path, e.display_name AS expected_display_name, e.storage_object_id AS expected_storage_object_id, sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc, {source_guard()} AS exact_source_match FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id ORDER BY e.target_album_id, e.filename_track, e.master_id;
""")
        write(output / f"postflight_{offset // 10 + 1:02d}.sql", f"""{cte(chunk)}
SELECT e.master_id, e.target_album_id AS expected_album_id, e.filename_track, e.instance_id, e.entry_id, e.source_id, e.parent_id, e.path AS expected_path, e.display_name AS expected_display_name, e.storage_object_id AS expected_storage_object_id, sm.id AS actual_master_id, sm.album_id AS actual_album_id, sm.track, sm.disc, {source_guard(nulls=False)} AS exact_source_match FROM expected e LEFT JOIN song_masters sm ON sm.id=e.master_id ORDER BY e.target_album_id, e.filename_track, e.master_id;
""")
    write(output / "apply_guarded.sql", f"""{all_cte}
UPDATE song_masters SET track=(SELECT e.filename_track FROM expected e WHERE e.master_id=song_masters.id), disc=1, updated_at=unixepoch() WHERE id IN (SELECT master_id FROM expected) AND (SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id WHERE {guard})=(SELECT COUNT(*) FROM expected);
""")
    write(output / "rollback_guarded.sql", f"""{all_cte}
UPDATE song_masters SET track=NULL, disc=NULL, updated_at=unixepoch() WHERE id IN (SELECT master_id FROM expected) AND (SELECT COUNT(*) FROM song_masters sm JOIN expected e ON e.master_id=sm.id WHERE {source_guard(nulls=False)})=(SELECT COUNT(*) FROM expected);
""")

if __name__ == "__main__": main(Path(sys.argv[1]), Path(sys.argv[2]))
