import argparse
import copy
import hashlib
import json
import re
import sqlite3
from pathlib import Path

CAPTURE_NAMES = {
    "album": "rushi8final0_live.json",
    "masters": "rushi8final1_live.json",
    "instances": "rushi8final2_live.json",
    "entries": "rushi8final3_live.json",
    "credits": "rushi8final4_live.json",
    "artists": "rushi8final21_live.json",
    "album_entries": "rushi8final6_live.json",
    "old_objects": "rushi8final7_live.json",
    "cache": "rushi8final22_live.json",
    "source": "rushi8final9_live.json",
    "schema": "rushi8final10_live.json",
    "group_members": "rushi8final11_live.json",
    "title_collision": "rushi8final12_live.json",
    "jobs": "rushi8final13_live.json",
    "queue0": "rushi8final14_0_live.json",
    "queue1": "rushi8final14_1_live.json",
    "parent_entries": "rushi8final15_0_live.json",
    "old_artist": "rushi8final16_live.json",
    "id_collision": "rushi8final17_live.json",
    "key_collision": "rushi8final20_live.json",
}


def load_rows(audit_dir: Path, name: str):
    blocks = json.loads((audit_dir / name).read_bytes().decode("utf-8"))
    return [row for block in blocks for row in block["results"]]


def load_json(path: Path):
    return json.loads(path.read_bytes().decode("utf-8"))


def sql_statements(raw: str):
    parts = []
    current = ""
    for char in raw:
        current += char
        if char == ";" and sqlite3.complete_statement(current):
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    assert "".join(parts) == raw, "SQL tokenizer changed the original bytes"
    return parts


def run_sql_file(con: sqlite3.Connection, package_dir: Path, name: str):
    raw_bytes = (package_dir / name).read_bytes()
    raw = raw_bytes.decode("utf-8")
    parts = sql_statements(raw)
    assert b"".join(part.encode("utf-8") for part in parts) == raw_bytes
    checks = 0
    for statement in parts:
        if not statement.strip():
            continue
        encoded = statement.encode("utf-8")
        assert len(encoded) < 100_000, (name, len(encoded))
        try:
            cur = con.execute(statement)
        except sqlite3.Error as exc:
            raise AssertionError((name, statement[:180], str(exc))) from exc
        if statement.lstrip().upper().startswith("SELECT CASE"):
            value = cur.fetchone()[0]
            assert value == "PASS", (name, value)
            checks += 1
    max_statement = max((len(statement.encode("utf-8")) for statement in parts), default=0)
    return checks, hashlib.sha256(raw.encode("utf-8")).hexdigest(), len(raw.encode("utf-8")), max_statement


def fail_guard(con: sqlite3.Connection, package_dir: Path, file_name: str, marker: str):
    raw = (package_dir / file_name).read_bytes().decode("utf-8")
    statement = next(s for s in sql_statements(raw) if marker in s)
    try:
        con.execute(statement)
    except sqlite3.Error:
        return
    raise AssertionError("expected guard rejection: " + marker)


def snapshot(con: sqlite3.Connection):
    data = {}
    for (table_name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        quoted = '"' + table_name.replace('"', '""') + '"'
        columns = [row[1] for row in con.execute("PRAGMA table_info(" + quoted + ")")]
        if columns:
            select_cols = ",".join('"' + c.replace('"', '""') + '"' for c in columns)
            data[table_name] = [tuple(row) for row in con.execute("SELECT " + select_cols + " FROM " + quoted)]
    return data


def normalized(value):
    if isinstance(value, bytes):
        return {"blob_hex": value.hex()}
    if isinstance(value, tuple):
        return [normalized(x) for x in value]
    if isinstance(value, list):
        return [normalized(x) for x in value]
    if isinstance(value, dict):
        return {k: normalized(v) for k, v in value.items()}
    return value


def canonical_rows(state):
    return {
        table: sorted((normalized(row) for row in rows), key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
        for table, rows in state.items()
    }


def row_dicts(con: sqlite3.Connection, state):
    result = {}
    for table, rows in state.items():
        quoted = '"' + table.replace('"', '""') + '"'
        cols = [row[1] for row in con.execute("PRAGMA table_info(" + quoted + ")")]
        result[table] = [dict(zip(cols, row)) for row in rows]
    return result


def make_snapshot(con: sqlite3.Connection, dict_rows):
    result = {}
    for table, rows in dict_rows.items():
        cols = [row[1] for row in con.execute('PRAGMA table_info("' + table.replace('"', '""') + '")')]
        result[table] = [tuple(row.get(col) for col in cols) for row in rows]
    return canonical_rows(result)


def insert_rows(con: sqlite3.Connection, table: str, records):
    if not records:
        return
    columns = list(records[0])
    names = ",".join('"' + col.replace('"', '""') + '"' for col in columns)
    marks = ",".join("?" for _ in columns)
    con.executemany(
        'INSERT INTO "' + table.replace('"', '""') + '" (' + names + ') VALUES (' + marks + ')',
        [[record[col] for col in columns] for record in records],
    )


def expected_afterimage(before, upload_items, stage_items, headers, artists, package_info, stamp):
    tables = {table: [dict(row) for row in rows] for table, rows in before.items()}
    plan = {row["current_master_id"]: row for row in stage_items}
    artist_by_name = {row["name"]: row["id"] for row in artists}
    aa_id = package_info["albumartist_id"]
    album_id = package_info["album_id"]

    album = next(row for row in tables["albums"] if row["id"] == album_id)
    album.update({
        "name": package_info["album"],
        "sort_name": package_info["album"],
        "year": package_info["year"],
        "genre": None,
        "cover_r2_key": package_info["cover_r2_key"],
        "song_count": package_info["tracks"],
        "duration": package_info["album_aggregate"]["duration"],
        "size": package_info["album_aggregate"]["size"],
        "compilation": package_info["compilation"],
        "updated_at": stamp,
    })

    target_master_ids = {item["source_master_id"] for item in upload_items}
    target_instance_by_master = {}
    target_entry_by_instance = {}
    for item in upload_items:
        stage = plan[item["source_master_id"]]
        header = headers[item["object_id"]]
        master = next(row for row in tables["song_masters"] if row["id"] == item["source_master_id"])
        instance = next(row for row in tables["song_instances"] if row["master_id"] == master["id"])
        entry = next(row for row in tables["storage_entries"] if row["instance_id"] == instance["id"])
        target_instance_by_master[master["id"]] = instance["id"]
        target_entry_by_instance[instance["id"]] = entry["id"]

        first_artist = artist_by_name[stage["artists"][0]]
        master.update({
            "artist_id": first_artist,
            "album_artist_id": aa_id,
            "title": stage["title"],
            "sort_title": stage["title"],
            "track": stage["track"],
            "genre": None,
            "compilation": 1,
            "updated_at": stamp,
        })
        instance.update({
            "storage_uri": "r2://" + item["physical_key"],
            "suffix": item["suffix"],
            "content_type": item["content_type"],
            "size": item["size"],
            "storage_object_id": item["object_id"],
            "source_etag": header["etag"],
            "source_last_modified": header["last_modified"],
            "updated_at": stamp,
        })
        entry.update({"object_id": item["object_id"], "updated_at": stamp})
        tables["storage_objects"].append({
            "id": item["object_id"],
            "physical_key": item["physical_key"],
            "legacy_key": None,
            "suffix": item["suffix"],
            "content_type": item["content_type"],
            "size": item["size"],
            "etag": header["etag"],
            "last_modified": header["last_modified"],
            "created_at": header["last_modified"],
            "updated_at": header["last_modified"],
        })

    tables["song_artists"] = [row for row in tables["song_artists"] if row["song_id"] not in target_master_ids]
    for item in upload_items:
        stage = plan[item["source_master_id"]]
        for position, name in enumerate(stage["artists"]):
            tables["song_artists"].append({
                "song_id": item["source_master_id"],
                "artist_id": artist_by_name[name],
                "position": position,
            })

    if tables["library_stats_cache"] and tables["library_stats_cache"][0]["dirty"] == 0:
        tables["library_stats_cache"][0]["dirty"] = 1
    return make_snapshot_from_tables(tables)


def make_snapshot_from_tables(tables):
    result = {}
    for table, rows in tables.items():
        result[table] = [tuple(row.values()) for row in rows]
    return canonical_rows(result)


def main():
    parser = argparse.ArgumentParser(description="Rehearse a frozen D1 SQL package against its captured schema and beforeimages.")
    parser.add_argument("--audit-dir", type=Path, required=True)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    audit_dir = args.audit_dir.resolve()
    package_dir = args.package_dir.resolve()
    receipt_path = args.receipt.resolve()

    info = load_json(package_dir / "package.json")
    for sql_name, expected_hash in info["sql_sha256"].items():
        raw = (package_dir / (sql_name + ".sql")).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == expected_hash, "frozen SQL pin changed: " + sql_name

    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    con.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
    assert con.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) == 100
    assert con.getlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH) == 100_000
    con.execute("PRAGMA foreign_keys=OFF")

    schema_rows = load_rows(audit_dir, CAPTURE_NAMES["schema"])
    table_ddls = [r for r in schema_rows if r["type"] == "table"]
    triggers = [r["sql"] for r in schema_rows if r["type"] == "trigger"]
    assert len(table_ddls) == 131 and len(triggers) == 20
    for row in table_ddls:
        if row["name"] != "sqlite_sequence":
            ddl = row["sql"]
            assert len(ddl.encode("utf-8")) < 100_000
            con.execute(ddl)

    capture = {key: load_rows(audit_dir, filename) for key, filename in CAPTURE_NAMES.items()}
    history_path = audit_dir / "rushi8_v6_live_job_reference_audit.json"
    history = load_json(history_path) if history_path.exists() else {"work_queue_rows": [], "transcode_rows": []}
    historical_work = history.get("work_queue_rows", [])
    historical_transcodes = history.get("transcode_rows", [])
    assert len(historical_work) == 8
    assert len(historical_transcodes) == 0
    assert all(row["status"] == "completed" for row in historical_work)
    backup_path = audit_dir / "rushi8_v6_history_target_rows.json"
    backup = load_json(backup_path) if backup_path.exists() else {"rows": []}
    backup_rows = backup.get("rows", [])
    assert len(backup_rows) == 0

    album_audio_entries = [row for row in capture["album_entries"] if row["instance_id"] is not None]
    assert sorted(album_audio_entries, key=lambda row: row["id"]) == sorted(capture["entries"], key=lambda row: row["id"])
    assert len(album_audio_entries) == len(capture["entries"]) == 8
    seed = {
        "storage_sources": capture["source"],
        "albums": capture["album"],
        "artists": capture["artists"] + capture["old_artist"],
        "storage_objects": capture["old_objects"],
        "song_masters": capture["masters"],
        "song_instances": capture["instances"],
        "storage_entries": capture["parent_entries"] + capture["album_entries"],
        "song_artists": capture["credits"],
        "library_stats_cache": capture["cache"],
        "work_queue": historical_work,
    }
    for row in backup_rows:
        seed.setdefault(row["_table"], []).append({k: v for k, v in row.items() if k != "_table"})
    assert tuple(len(seed[k]) for k in ["albums", "artists", "song_masters", "song_instances", "song_artists", "storage_objects", "storage_entries", "library_stats_cache", "work_queue"]) == (1, 10, 8, 8, 8, 10, 12, 1, 8)

    # Completed task rows retain their real claimed_by value while this fixture supplies only an FK placeholder.
    con.execute("INSERT INTO users(username,master_password) VALUES('admin','fixture-only')")
    con.commit()
    for table, records in seed.items():
        insert_rows(con, table, records)
    con.commit()
    for trigger_sql in triggers:
        con.execute(trigger_sql)
    con.commit()
    assert con.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0] == 20
    con.execute("PRAGMA foreign_keys=ON")
    assert con.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []

    before = snapshot(con)
    before_rows = row_dicts(con, before)
    upload_doc = load_json(audit_dir / "rushi8_native_root_upload_20261003t1120.json")
    upload = upload_doc["items"]
    stage_doc = load_json(audit_dir / "rushi_native_stage_v2" / "stage_manifest.json")
    stage = stage_doc["items"]
    header_doc = load_json(audit_dir / "rushi8_native_root_upload_20261003t1120_r2_headers.json")
    headers = {row["object_id"]: row for row in header_doc["items"]}
    expected_artists = capture["artists"] + capture["old_artist"]
    apply_sql = (package_dir / "apply.sql").read_bytes().decode("utf-8")
    m = re.search(r"UPDATE albums SET[\s\S]*?updated_at=(\d+) WHERE", apply_sql)
    assert m, "cannot derive apply timestamp from frozen SQL"
    stamp = int(m.group(1))

    initial = canonical_rows(before)
    expected = expected_afterimage(before_rows, upload, stage, headers, expected_artists, info, stamp)
    before_count = len(before)
    apply_checks, apply_sha, apply_bytes, apply_max = run_sql_file(con, package_dir, "apply.sql")
    post_checks, post_sha, post_bytes, post_max = run_sql_file(con, package_dir, "postflight.sql")
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    actual_after = canonical_rows(snapshot(con))
    if actual_after != expected:
        differences = {table: {"actual_count": len(actual_after[table]), "expected_count": len(expected[table]),
                               "actual_first": actual_after[table][:1], "expected_first": expected[table][:1]}
                       for table in actual_after if actual_after[table] != expected[table]}
        raise AssertionError({"full_afterimage_mismatch": list(differences), "details": differences})
    deltas = {}
    for table in actual_after:
        if actual_after[table] != initial[table]:
            deltas[table] = {"before": len(initial[table]), "after": len(actual_after[table])}
    assert set(deltas) == {"albums", "song_artists", "song_instances", "song_masters", "storage_entries", "storage_objects"}, deltas
    assert deltas.get("song_artists") == {"before": 8, "after": 16}
    assert deltas.get("storage_objects") == {"before": 10, "after": 18}
    assert all(con.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] == len(actual_after[table]) for table in actual_after)
    con.commit()
    postimage = snapshot(con)

    con.execute("BEGIN")
    target_master = upload[0]["source_master_id"]
    con.execute("UPDATE song_masters SET title=title||' stale' WHERE id=?", (target_master,))
    fail_guard(con, package_dir, "rollback.sql", "rollback_master_postimage_changed")
    con.rollback()
    assert canonical_rows(snapshot(con)) == canonical_rows(postimage)

    con.execute("BEGIN")
    rollback_checks, rollback_sha, rollback_bytes, rollback_max = run_sql_file(con, package_dir, "rollback.sql")
    rollback_post_checks, rollback_post_sha, rollback_post_bytes, rollback_post_max = run_sql_file(con, package_dir, "rollback_postflight.sql")
    try:
        con.execute("INSERT INTO song_masters(id,album_id,artist_id,title) VALUES('late-rollback-failure',NULL,NULL,NULL)")
    except sqlite3.IntegrityError:
        con.rollback()
    else:
        raise AssertionError("late rollback failure fixture unexpectedly succeeded")
    assert canonical_rows(snapshot(con)) == canonical_rows(postimage), "late rollback error did not restore complete applied afterimage"

    rollback_checks, rollback_sha, rollback_bytes, rollback_max = run_sql_file(con, package_dir, "rollback.sql")
    rollback_post_checks, rollback_post_sha, rollback_post_bytes, rollback_post_max = run_sql_file(con, package_dir, "rollback_postflight.sql")
    assert canonical_rows(snapshot(con)) == initial, "complete 131-table rollback did not restore beforeimage"
    con.commit()

    stale_id = seed["song_masters"][0]["id"]
    before_master = next(row for row in seed["song_masters"] if row["id"] == stale_id)
    con.execute("UPDATE song_masters SET title=title||' stale' WHERE id=?", (stale_id,))
    fail_guard(con, package_dir, "apply.sql", "master_beforeimage_changed")
    con.execute("UPDATE song_masters SET title=? WHERE id=?", (before_master["title"], stale_id))
    con.commit()

    target_instances = [row["id"] for row in seed["song_instances"]]
    for index, instance_id in enumerate(target_instances):
        con.execute("INSERT INTO work_queue(id,task_type,payload,status) VALUES(?,?,?,'queued')",
                    ("fixture-active-target-" + str(index), "metadata", json.dumps({"instanceId": instance_id})))
    fail_guard(con, package_dir, "apply.sql", "target_queued_or_claimed_work_exists")
    con.execute("DELETE FROM work_queue WHERE id LIKE 'fixture-active-target-%'")
    con.commit()

    con.execute("INSERT INTO storage_objects(id,physical_key,suffix,size) VALUES(?,?,?,1)", (upload[0]["object_id"], "fixture-key", "flac"))
    fail_guard(con, package_dir, "apply.sql", "new_object_id_collision")
    con.execute("DELETE FROM storage_objects WHERE id=?", (upload[0]["object_id"],))
    con.commit()
    assert canonical_rows(snapshot(con)) == initial

    con.execute("BEGIN")
    run_sql_file(con, package_dir, "apply.sql")
    run_sql_file(con, package_dir, "postflight.sql")
    try:
        con.execute("INSERT INTO song_masters(id,album_id,artist_id,title) VALUES('late-apply-failure',NULL,NULL,NULL)")
    except sqlite3.IntegrityError:
        con.rollback()
    else:
        raise AssertionError("late apply failure fixture unexpectedly succeeded")
    assert canonical_rows(snapshot(con)) == initial, "late apply error did not restore complete beforeimage"
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []

    files = ["apply", "postflight", "rollback", "rollback_postflight"]
    pins = {name: hashlib.sha256((package_dir / (name + ".sql")).read_bytes()).hexdigest() for name in files}
    receipt = {
        "status": "PASS",
        "package_sql_pins": pins,
        "actual_live_tables": before_count,
        "actual_live_triggers": 20,
        "foreign_keys_enabled_before_apply": 1,
        "expression_depth_limit": con.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH),
        "sql_length_limit": con.getlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH),
        "raw_sql_join_identity": True,
        "max_statement_bytes": max(apply_max, post_max, rollback_max, rollback_post_max),
        "max_sql_file_bytes": max(apply_bytes, post_bytes, rollback_bytes, rollback_post_bytes),
        "full_fixture_snapshots": before_count,
        "independent_expected_afterimage": "PASS across all 131 fixture tables",
        "table_deltas": deltas,
        "expected_mutations": {"albums": 1, "song_masters": 8, "song_instances": 8, "storage_entries": 8, "song_artists_before_after": [8, 16], "storage_objects_before_after": [10, 18], "library_stats_cache": "unchanged; before dirty=1"},
        "captured_completed_work_queue_history_rows": 8,
        "transcode_jobs": 0,
        "backup_history_references": 0,
        "historical_rows_preserved_fullrow": True,
        "synthetic_fk_parent": "minimal users(admin) fixture row; no production credential fields copied",
        "apply_guards": apply_checks,
        "post_guards": post_checks,
        "rollback_guards": rollback_checks,
        "rollback_post_guards": rollback_post_checks,
        "full_row_rollback_exact": True,
        "negative_guards": ["stale target row", "stale rollback afterimage", "active queued target", "object ID collision"],
        "late_apply_failure_atomic_rollback": True,
        "late_rollback_failure_atomic_rollback": True,
        "foreign_key_check": "PASS",
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
