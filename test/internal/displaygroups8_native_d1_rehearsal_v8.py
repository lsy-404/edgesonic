import argparse
import copy
import hashlib
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


def read_sql(raw):
    source = raw.decode("utf-8")
    statements = []
    pending = ""
    for line in source.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            statements.append(pending)
            pending = ""
    if pending:
        raise AssertionError("incomplete SQL statement")
    assert "".join(statements) == source
    return statements


def snapshot(db):
    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )]
    result = {}
    for table in tables:
        columns = [r[1] for r in db.execute(f"PRAGMA table_info(\"{table}\")")]
        rows = db.execute(f"SELECT * FROM \"{table}\"").fetchall()
        result[table] = sorted(
            (dict(zip(columns, row)) for row in rows),
            key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, default=str),
        )
    return result


def insert_rows(db, table, rows):
    for row in rows:
        cols = list(row)
        marks = ",".join("?" for _ in cols)
        db.execute(f"INSERT INTO \"{table}\" ({','.join(cols)}) VALUES ({marks})",
                   [row[c] for c in cols])


def create_fixture(audit, before, write_epoch, bundle_path, trigger_file):
    bundle_raw = bundle_path.read_bytes()
    bundle = json.loads(bundle_raw.decode("utf-8"))
    schema = bundle["schema"]
    pinned_triggers = json.loads(trigger_file.read_bytes().decode("utf-8"))
    live_triggers = [item["sql"] for item in schema if item.get("type") == "trigger"]
    assert len(pinned_triggers) == len(live_triggers) == 20
    assert {item["sql"] for item in pinned_triggers} == set(live_triggers)
    db = sqlite3.connect(":memory:")
    db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    for item in schema:
        sql = item.get("sql")
        if item.get("type") == "table" and sql and item["name"] != "sqlite_sequence":
            db.execute(sql)
    db.execute("PRAGMA foreign_keys=OFF")
    for table, rows in bundle["tables"].items():
        if table in {"active_jobs"}:
            continue
        if table in {"lyrics_search_grams"}:
            continue
        if table not in {r["name"] for r in schema if r.get("type") == "table"}:
            continue
        insert_rows(db, table, rows)
    insert_rows(db, "lyrics_search_grams", before["tables"]["lyrics_search_grams"])
    db.commit()
    db.execute("PRAGMA foreign_keys=ON")
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    for item in schema:
        if item.get("type") == "index" and item.get("sql"):
            db.execute(item["sql"])
    for item in schema:
        if item.get("type") == "trigger" and item.get("sql"):
            db.execute(item["sql"])
    assert db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0] == 20
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    return db, bundle_raw, schema


def execute_atomic(db, statements, fail_at_end=False):
    db.execute("BEGIN IMMEDIATE")
    try:
        for statement in statements:
            db.execute(statement)
        if fail_at_end:
            db.execute("INSERT INTO work_queue(id,task_type,payload,status) "
                       "VALUES('forced-late-failure','metadata','{}','guard_failed')")
        db.commit()
    except Exception:
        db.rollback()
        raise


def index_rows(rows, key):
    return {row[key]: row for row in rows}


def build_expected(initial, before, write_epoch):
    expected = copy.deepcopy(initial)
    tables = before["tables"]
    pairs = before["pairs"]
    def bykey(table, key):
        return index_rows(expected[table], key)
    def remove(table, key, value):
        expected[table][:] = [row for row in expected[table] if row[key] != value]

    for pair in pairs:
        keep, retire = pair["keep_master"], pair["retire_master"]
        ki, ri = pair["keep_instance"], pair["retire_instance"]
        ke, re = pair["keep_entry"], pair["retire_entry"]
        n, h, audio = pair["new"], pair["header"], pair["audio"]
        objects = bykey("storage_objects", "id")
        for old in (pair["old_keep_object"], pair["old_retire_object"]):
            remove("storage_objects", "id", old["id"])
        expected["storage_objects"].append({
            "id": n["object_id"], "physical_key": n["physical_key"], "legacy_key": None,
            "suffix": n["suffix"], "content_type": n["content_type"], "size": n["size"],
            "etag": h["etag"], "last_modified": h["last_modified"],
            "created_at": h["last_modified"], "updated_at": h["last_modified"],
        })
        instances = bykey("song_instances", "id")
        keeper = instances[ki["id"]]
        keeper.update({
            "storage_object_id": n["object_id"], "storage_uri": "r2://" + n["physical_key"],
            "suffix": n["suffix"], "content_type": n["content_type"], "size": n["size"],
            "source_etag": h["etag"], "source_last_modified": h["last_modified"],
            "bit_rate": audio["bitrate"], "sample_rate": audio["sample_rate"],
            "bit_depth": audio["bit_depth"], "channels": audio["channels"],
            "duration": audio["duration"], "updated_at": write_epoch,
        })
        remove("song_instances", "id", ri["id"])
        entries = bykey("storage_entries", "id")
        entries[ke["id"]].update({"object_id": n["object_id"], "updated_at": write_epoch})
        remove("storage_entries", "id", re["id"])
        remove("song_masters", "id", retire["id"])

    for pair in pairs:
        fields = pair.get("keeper_master_after", {})
        if not fields:
            continue
        master_id = pair["keep_master"]["id"]
        row = bykey("song_masters", "id")[master_id]
        previous_lyrics = row.get("lyrics")
        row.update(fields)
        row["updated_at"] = write_epoch
        if row.get("lyrics") != previous_lyrics:
            dirty = expected["lyrics_search_dirty"]
            existing = next((r for r in dirty if r["song_id"] == master_id), None)
            if existing:
                existing["revision"] += 1
            else:
                dirty.append({"song_id": master_id, "revision": 0})

    credits = expected["song_artists"]
    credit_set = {(r["song_id"], r["artist_id"], r["position"]) for r in credits}
    retire_ids = {p["retire_master"]["id"] for p in pairs}
    for row in tables["song_artists"]:
        if row["song_id"] in retire_ids:
            mapped = next(p["keep_master"]["id"] for p in pairs
                          if p["retire_master"]["id"] == row["song_id"])
            candidate = (mapped, row["artist_id"], row["position"])
            if candidate not in credit_set:
                credits.append({"song_id": candidate[0], "artist_id": candidate[1],
                                "position": candidate[2]})
                credit_set.add(candidate)
    expected["song_artists"] = [r for r in credits if r["song_id"] not in retire_ids]

    docs = expected["lyrics_search_documents"]
    grams = expected["lyrics_search_grams"]
    for pair in pairs:
        rid, kid = pair["retire_master"]["id"], pair["keep_master"]["id"]
        old_docs = [r for r in docs if r["song_id"] == rid]
        for row in old_docs:
            docs.append({"song_id": kid, "body": row["body"]})
        docs[:] = [r for r in docs if r["song_id"] != rid]
        old_grams = [r for r in grams if r["song_id"] == rid]
        for row in old_grams:
            grams.append({"gram": row["gram"], "song_id": kid})
        grams[:] = [r for r in grams if r["song_id"] != rid]

    for aid, after in before["album_after"].items():
        row = bykey("albums", "id")[aid]
        row.update({"song_count": after["song_count"], "duration": after["duration"],
                    "size": after["size"], "updated_at": write_epoch})
    if retire_ids:
        for row in expected["library_stats_cache"]:
            if row["id"] == 1 and row["dirty"] == 0:
                row["dirty"] = 1
    for table in expected:
        expected[table].sort(key=lambda row: json.dumps(row, ensure_ascii=False,
                                                        sort_keys=True, default=str))
    return expected


def assert_fails_unchanged(audit, before, apply_statements, mutate, label, write_epoch, bundle_path, trigger_file):
    db, _, _ = create_fixture(audit, before, write_epoch, bundle_path, trigger_file)
    mutate(db, before)
    db.commit()
    baseline = snapshot(db)
    try:
        execute_atomic(db, apply_statements)
        raise AssertionError(f"negative test unexpectedly passed: {label}")
    except sqlite3.IntegrityError:
        pass
    assert snapshot(db) == baseline, label
    db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-dir", type=Path, required=True)
    parser.add_argument("--stem", required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--trigger-ddl", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    audit = args.audit_dir.resolve()
    trigger_file = args.trigger_ddl.resolve()
    bundle_path = args.bundle.resolve()
    apply_raw = (audit / f"{args.stem}_apply.sql").read_bytes()
    rollback_raw = (audit / f"{args.stem}_rollback.sql").read_bytes()
    before = json.loads((audit / f"{args.stem}_beforeimage.json").read_bytes().decode("utf-8"))
    manifest_raw = (audit / f"{args.stem}_manifest.json").read_bytes()
    manifest = json.loads(manifest_raw.decode("utf-8"))
    inputs = {
        "apply_sha256": hashlib.sha256(apply_raw).hexdigest(),
        "rollback_sha256": hashlib.sha256(rollback_raw).hexdigest(),
        "beforeimage_sha256": hashlib.sha256((audit / f"{args.stem}_beforeimage.json").read_bytes()).hexdigest(),
        "postconditions_sha256": hashlib.sha256((audit / f"{args.stem}_postconditions.json").read_bytes()).hexdigest(),
        "bundle_sha256": hashlib.sha256(bundle_path.read_bytes()).hexdigest(),
        "trigger_ddl_sha256": hashlib.sha256(trigger_file.read_bytes()).hexdigest(),
        "runner_sha256": hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest(),
    }
    for key, actual in inputs.items():
        assert manifest[key] == actual, (key, manifest.get(key), actual)
    for relative, expected_sha in manifest["source_files"].items():
        actual_sha = hashlib.sha256((audit / relative).read_bytes()).hexdigest()
        assert expected_sha["sha256"] == actual_sha, (relative, expected_sha, actual_sha)
    apply = read_sql(apply_raw)
    rollback = read_sql(rollback_raw)
    write_epoch = manifest["write_epoch"]
    assert isinstance(write_epoch, int)
    generated = datetime.fromisoformat(manifest["generated_at_utc"].replace("Z", "+00:00"))
    assert int(generated.timestamp()) == write_epoch
    runtime_epoch = int(time.time())
    assert write_epoch <= runtime_epoch, (write_epoch, runtime_epoch)
    assert b"unixepoch()" not in apply_raw, "apply must pin one real generation epoch"
    assert str(write_epoch).encode("ascii") in apply_raw, "apply must contain the generated epoch literal"
    db, bundle_raw, schema = create_fixture(audit, before, write_epoch, bundle_path, trigger_file)
    initial = snapshot(db)
    expected = build_expected(initial, before, write_epoch)
    execute_atomic(db, apply)
    actual = snapshot(db)
    if actual != expected:
        differing = {name: {"expected": len(expected.get(name, [])), "actual": len(actual.get(name, []))}
                     for name in set(expected) | set(actual)
                     if expected.get(name) != actual.get(name)}
        raise AssertionError({"full_afterimage_mismatch": differing})
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"

    pairs = before["pairs"]
    first = pairs[0]
    assert_fails_unchanged(
        audit, before, apply,
        lambda conn, _: conn.execute("UPDATE song_masters SET title=title||' stale' WHERE id=?",
                                     (first["keep_master"]["id"],)),
        "stale full-row guard", write_epoch, bundle_path, trigger_file)
    assert_fails_unchanged(
        audit, before, apply,
        lambda conn, _: conn.execute("UPDATE song_masters SET updated_at=updated_at-1 WHERE id=?",
                                     (first["keep_master"]["id"],)),
        "stale keeper timestamp guard", write_epoch, bundle_path, trigger_file)
    def collision(conn, _):
        n = first["new"]
        conn.execute("INSERT INTO storage_objects(id,physical_key,suffix,size) VALUES(?,?,?,0)",
                     (n["object_id"], "objects/collision.flac", "flac"))
    assert_fails_unchanged(audit, before, apply, collision, "new object id collision", write_epoch, bundle_path, trigger_file)
    def key_collision(conn, _):
        n = first["new"]
        conn.execute("INSERT INTO storage_objects(id,physical_key,suffix,size) VALUES(?,?,?,0)",
                     ("unrelated-key-collision", n["physical_key"], "flac"))
    assert_fails_unchanged(audit, before, apply, key_collision, "new physical key collision", write_epoch, bundle_path, trigger_file)
    def active_job(conn, _):
        conn.execute("INSERT INTO work_queue(id,task_type,payload,status) VALUES(?,?,?,'queued')",
                     ("active-target", "metadata", json.dumps({"master_id": first["keep_master"]["id"]})))
    assert_fails_unchanged(audit, before, apply, active_job, "active target job", write_epoch, bundle_path, trigger_file)
    def dirty_lyric(conn, _):
        conn.execute("INSERT INTO lyrics_search_dirty(song_id,revision) VALUES(?,0)",
                     (first["keep_master"]["id"],))
    assert_fails_unchanged(audit, before, apply, dirty_lyric, "dirty lyric reference", write_epoch, bundle_path, trigger_file)
    def stale_cache(conn, _):
        conn.execute("UPDATE library_stats_cache SET updated_at=0 WHERE id=1")
    assert_fails_unchanged(audit, before, apply, stale_cache, "stale shared cache row", write_epoch, bundle_path, trigger_file)

    late_apply, _, _ = create_fixture(audit, before, write_epoch, bundle_path, trigger_file)
    baseline = snapshot(late_apply)
    try:
        execute_atomic(late_apply, apply, fail_at_end=True)
        raise AssertionError("late apply test did not fail")
    except sqlite3.IntegrityError:
        pass
    assert snapshot(late_apply) == baseline
    late_apply.close()

    rollback_db, _, _ = create_fixture(audit, before, write_epoch, bundle_path, trigger_file)
    rollback_initial = snapshot(rollback_db)
    execute_atomic(rollback_db, apply)
    post_apply = snapshot(rollback_db)
    try:
        execute_atomic(rollback_db, rollback, fail_at_end=True)
        raise AssertionError("late rollback test did not fail")
    except sqlite3.IntegrityError:
        pass
    assert snapshot(rollback_db) == post_apply
    execute_atomic(rollback_db, rollback)
    rolled_back = snapshot(rollback_db)
    if rolled_back != rollback_initial:
        details = {name: {"initial_rows": len(rollback_initial.get(name, [])),
                          "rolled_back_rows": len(rolled_back.get(name, []))}
                   for name in set(rollback_initial) | set(rolled_back) if rollback_initial.get(name) != rolled_back.get(name)}
        raise AssertionError({"rollback_snapshot_diff": details})
    rollback_db.close()

    result = {
        "status": "PASS_INDEPENDENT_FULL_AFTERIMAGE_AND_NEGATIVES",
        "production_writes": 0,
        "write_epoch": write_epoch,
        "sqlite_runtime_epoch": runtime_epoch,
        "fake_clock_registered": False,
        "apply_sha256": hashlib.sha256(apply_raw).hexdigest(),
        "rollback_sha256": hashlib.sha256(rollback_raw).hexdigest(),
        "bundle_sha256": hashlib.sha256(bundle_raw).hexdigest(),
        "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
        "rehearsal_beforeimage_table_count": len(before["tables"]),
        "bundle_row_tables": len(before["bundle_table_names"]),
        "schema_object_count": len(schema),
        "live_trigger_count": 20,
        "trigger_ddl_sha256": hashlib.sha256(trigger_file.read_bytes()).hexdigest(),
        "sqlite_limits": {"sql_length": 100000, "expr_depth": 100},
        "foreign_keys_enabled_after_seed_commit": 1,
        "full_table_count_compared": len(initial),
        "full_expected_afterimage_match": True,
        "max_statement_bytes": max(max(len(s.encode("utf-8")) for s in apply),
                                    max(len(s.encode("utf-8")) for s in rollback)),
        "negative_tests": ["stale_full_row_guard", "stale_keeper_timestamp_guard", "new_object_id_collision",
                            "new_physical_key_collision", "active_target_job", "dirty_lyric_reference",
                            "stale_shared_cache_row"],
        "late_apply_failure_atomic": True,
        "late_rollback_failure_atomic": True,
        "rollback_full_table_snapshot_exact": True,
        "foreign_key_check": "PASS",
        "quick_check": "PASS",
        "note": "The bundle omits untouched lyrics_search_grams; the 542 affected rows are seeded from the pinned beforeimage and included in the full-table comparison.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    db.close()


if __name__ == "__main__":
    main()
