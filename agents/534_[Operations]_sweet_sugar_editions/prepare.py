import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SNAPSHOT = json.loads((ROOT / "primary_snapshot.json").read_text(encoding="utf-8"))
ROWS = SNAPSHOT["result"][0]["results"]
ALBUM = SNAPSHOT["result"][1]["results"][0]
SOURCE = "al-1aee8da1c9"
FLAC = "al-8b7626106c"
GROUP = "ag-sweet-sugar-editions-20260926"

COLUMNS = [
    "master_id", "album_id", "artist_id", "album_artist_id", "title",
    "sort_title", "disc", "track", "duration", "genre", "instance_id",
    "instance_master_id", "source_id", "source_type", "storage_uri",
    "storage_object_id", "suffix", "instance_size", "missing", "tag_scanned",
    "object_id", "physical_key", "object_size", "entry_id", "entry_source_id",
    "parent_id", "path", "kind", "entry_instance_id", "entry_object_id",
]


def sql(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def expected_cte():
    values = ",\n".join(
        "  (" + ", ".join(sql(row[col]) for col in COLUMNS) + ")" for row in ROWS
    )
    return "WITH expected(" + ",".join(COLUMNS) + ") AS (VALUES\n" + values + "\n)"


def join_expected(final=False):
    album_expr = f"CASE WHEN e.suffix='flac' THEN '{FLAC}' ELSE '{SOURCE}' END" if final else "e.album_id"
    disc_expr = "CASE WHEN e.suffix='flac' THEN 1 ELSE e.disc END" if final else "e.disc"
    master = [
        ("id", "master_id"), ("artist_id", "artist_id"),
        ("album_artist_id", "album_artist_id"), ("title", "title"),
        ("sort_title", "sort_title"), ("track", "track"),
        ("duration", "duration"), ("genre", "genre"),
    ]
    instance = [
        ("id", "instance_id"), ("master_id", "instance_master_id"),
        ("source_id", "source_id"), ("source_type", "source_type"),
        ("storage_uri", "storage_uri"), ("storage_object_id", "storage_object_id"),
        ("suffix", "suffix"), ("size", "instance_size"),
        ("missing", "missing"), ("tag_scanned", "tag_scanned"),
    ]
    obj = [("id", "object_id"), ("physical_key", "physical_key"), ("size", "object_size")]
    entry = [
        ("id", "entry_id"), ("source_id", "entry_source_id"),
        ("parent_id", "parent_id"), ("path", "path"), ("kind", "kind"),
        ("instance_id", "entry_instance_id"), ("object_id", "entry_object_id"),
    ]
    cond = lambda alias, fields: " AND ".join(f"{alias}.{db} IS e.{ex}" for db, ex in fields)
    return (
        "FROM expected e\n"
        f"JOIN song_masters sm ON {cond('sm', master)} AND sm.album_id IS ({album_expr}) AND sm.disc IS ({disc_expr})\n"
        f"JOIN song_instances si ON {cond('si', instance)}\n"
        f"JOIN storage_objects so ON {cond('so', obj)}\n"
        f"JOIN storage_entries se ON {cond('se', entry)}"
    )


def assertion(count):
    return f"SELECT CASE WHEN changes()={count} THEN 1 ELSE abs(-9223372036854775808) END;\n"


def main():
    assert len(ROWS) == 23
    assert {r["album_id"] for r in ROWS} == {SOURCE}
    assert len({r["master_id"] for r in ROWS}) == 23
    assert len({r["instance_id"] for r in ROWS}) == 23
    assert len({r["object_id"] for r in ROWS}) == 23
    assert len({r["entry_id"] for r in ROWS}) == 23
    by_suffix = {kind: [r for r in ROWS if r["suffix"] == kind] for kind in ("mp3", "flac")}
    assert len(by_suffix["mp3"]) == 12 and len(by_suffix["flac"]) == 11
    assert sorted(r["track"] for r in by_suffix["mp3"]) == list(range(1, 13))
    assert sorted(r["track"] for r in by_suffix["flac"]) == list(range(2, 13))
    assert {r["disc"] for r in by_suffix["mp3"]} == {1}
    assert {r["disc"] for r in by_suffix["flac"]} == {None}
    assert sum(r["duration"] for r in by_suffix["mp3"]) == 2775
    assert sum(r["duration"] for r in by_suffix["flac"]) == 2738
    assert sum(r["instance_size"] for r in by_suffix["mp3"]) == 44989327
    assert sum(r["instance_size"] for r in by_suffix["flac"]) == 365724208
    assert ALBUM["id"] == SOURCE and ALBUM["song_count"] == 23
    assert ALBUM["duration"] == 5513 and ALBUM["size"] == 410713535
    assert SNAPSHOT["result"][2]["results"] == [{"group_members": 0}]
    assert SNAPSHOT["result"][3]["results"] == [{"target_group_conflicts": 0}]

    cte = expected_cte()
    preflight = (
        cte + "\nSELECT e.master_id,e.suffix,e.track,e.instance_id,e.object_id,e.entry_id,"
        "CASE WHEN sm.id IS NOT NULL AND si.id IS NOT NULL AND so.id IS NOT NULL AND se.id IS NOT NULL THEN 1 ELSE 0 END AS exact_match\n"
        + join_expected().replace("JOIN ", "LEFT JOIN ") + "\nORDER BY e.suffix,e.track;\n"
        + f"SELECT id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at FROM albums WHERE id IN ('{SOURCE}','{FLAC}') ORDER BY id;\n"
        + f"SELECT COUNT(*) AS group_members FROM album_display_group_members WHERE album_id IN ('{SOURCE}','{FLAC}');\n"
        + f"SELECT COUNT(*) AS group_conflicts FROM album_display_groups WHERE id='{GROUP}' OR display_name='Sweet Sugar';\n"
        + f"SELECT COUNT(*) AS active_scoped FROM work_queue w WHERE w.status IN ('queued','claimed') AND json_valid(w.payload)=1 AND json_extract(w.payload,'$.instanceId') IN (SELECT si.id FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='{SOURCE}');\n"
    )
    (ROOT / "preflight.sql").write_text(preflight, encoding="utf-8")

    album_conditions = " AND ".join(
        f"{field} IS {sql(ALBUM[field])}" for field in
        ("name", "sort_name", "year", "genre", "cover_r2_key", "song_count",
         "duration", "size", "compilation", "created_at", "updated_at")
    )
    guard = (
        f"(SELECT COUNT(*)=23 {join_expected()})"
        f" AND (SELECT COUNT(*)=23 FROM expected)"
        f" AND (SELECT {album_conditions} FROM albums WHERE id='{SOURCE}')"
        f" AND (SELECT COUNT(*)=23 AND COALESCE(SUM(duration),0)=5513 FROM song_masters WHERE album_id='{SOURCE}')"
        f" AND (SELECT COALESCE(SUM(si.size),0)=410713535 FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='{SOURCE}')"
        f" AND NOT EXISTS(SELECT 1 FROM albums WHERE id='{FLAC}')"
        f" AND NOT EXISTS(SELECT 1 FROM album_display_groups WHERE id='{GROUP}' OR display_name='Sweet Sugar')"
        f" AND NOT EXISTS(SELECT 1 FROM album_display_group_members WHERE album_id IN ('{SOURCE}','{FLAC}'))"
        f" AND NOT EXISTS(SELECT 1 FROM work_queue w WHERE w.status IN ('queued','claimed') AND json_valid(w.payload)=1 AND json_extract(w.payload,'$.instanceId') IN (SELECT si.id FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='{SOURCE}'))"
    )
    flac_ids = ",".join(sql(r["master_id"]) for r in by_suffix["flac"])
    apply = [
        cte + "\nINSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at) "
        + f"SELECT '{FLAC}','Sweet Sugar (FLAC)','sweet sugar flac',NULL,NULL,'covers/{FLAC}',11,2738,365724208,0,unixepoch(),unixepoch() WHERE {guard};\n",
        assertion(1),
        f"UPDATE song_masters SET album_id='{FLAC}',disc=1,updated_at=unixepoch() WHERE album_id='{SOURCE}' AND id IN ({flac_ids}) AND EXISTS(SELECT 1 FROM albums WHERE id='{FLAC}');\n",
        assertion(11),
        f"INSERT INTO album_display_groups(id,display_name,sort_name,created_at,updated_at) VALUES('{GROUP}','Sweet Sugar','sweet sugar',unixepoch(),unixepoch());\n",
        assertion(1),
        f"INSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES('{GROUP}','{SOURCE}',0);\n",
        assertion(1),
        f"INSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES('{GROUP}','{FLAC}',1);\n",
        assertion(1),
        f"UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN ('{SOURCE}','{FLAC}');\n",
        assertion(2),
    ]
    final = (
        f"(SELECT COUNT(*)=23 {join_expected(final=True)})"
        f" AND (SELECT COUNT(*)=12 AND COUNT(DISTINCT track)=12 AND MIN(track)=1 AND MAX(track)=12 FROM song_masters WHERE album_id='{SOURCE}' AND disc=1)"
        f" AND (SELECT COUNT(*)=11 AND COUNT(DISTINCT track)=11 AND MIN(track)=2 AND MAX(track)=12 FROM song_masters WHERE album_id='{FLAC}' AND disc=1)"
        f" AND (SELECT song_count=12 AND duration=2775 AND size=44989327 AND compilation=1 AND name='Sweet Sugar' AND cover_r2_key='covers/{SOURCE}' FROM albums WHERE id='{SOURCE}')"
        f" AND (SELECT song_count=11 AND duration=2738 AND size=365724208 AND compilation=0 AND name='Sweet Sugar (FLAC)' AND cover_r2_key='covers/{FLAC}' FROM albums WHERE id='{FLAC}')"
        f" AND (SELECT COUNT(*)=2 FROM album_display_group_members WHERE group_id='{GROUP}')"
        f" AND (SELECT sort_order=0 FROM album_display_group_members WHERE group_id='{GROUP}' AND album_id='{SOURCE}')"
        f" AND (SELECT sort_order=1 FROM album_display_group_members WHERE group_id='{GROUP}' AND album_id='{FLAC}')"
    )
    apply.append(cte + f"\nSELECT CASE WHEN {final} THEN 1 ELSE abs(-9223372036854775808) END;\n")
    (ROOT / "apply_guarded.sql").write_text("\n".join(apply), encoding="utf-8")


if __name__ == "__main__":
    main()
