import argparse
import hashlib
import json
import sqlite3
import tempfile
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_bytes().decode("utf-8"))


def split_sql(raw):
    text = raw.decode("utf-8")
    statements, current = [], ""
    for character in text:
        current += character
        if character == ";" and sqlite3.complete_statement(current):
            statements.append(current)
            current = ""
    if current.strip():
        raise AssertionError("SQL split did not preserve the original bytes")
    if current and statements:
        statements[-1] += current
    if b"".join(item.encode("utf-8") for item in statements) != raw:
        raise AssertionError("SQL split did not preserve the original bytes")
    if any(len(item.encode("utf-8")) >= 100_000 for item in statements):
        raise AssertionError("An individual SQL statement exceeds 100 KB")
    return statements


def snapshot(conn, tables):
    result = {}
    for table in tables:
        rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
        result[table] = sorted(rows, key=lambda row: json.dumps(row, ensure_ascii=True, default=str))
    return result


def insert_rows(conn, table, rows):
    for row in rows:
        columns = list(row)
        sql = f'INSERT INTO "{table}" (' + ",".join(f'"{name}"' for name in columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")"
        conn.execute(sql, [row[name] for name in columns])


def make_fixture(db_path, bundle_path, capture_dir, capture_stem, artist_capture_stem):
    bundle = load(bundle_path)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=OFF")
    for kind in ("table", "index"):
        for item in bundle["schema"]:
            if item["type"] == kind and item["sql"] and not item["name"].startswith("sqlite_"):
                conn.execute(item["sql"])

    def rows(name, stem=capture_stem):
        return load(capture_dir / f"{stem}_{name}.json")["rows"]

    insert_rows(conn, "albums", rows("album"))
    insert_rows(conn, "artists", rows("artists") + rows("referenced_artists", artist_capture_stem))
    insert_rows(conn, "song_masters", rows("masters"))
    insert_rows(conn, "storage_objects", rows("old_objects"))
    insert_rows(conn, "storage_sources", rows("sources"))
    conn.execute("INSERT INTO users(username,master_password) VALUES('admin','fixture-only')")
    insert_rows(conn, "song_instances", rows("instances"))
    insert_rows(conn, "storage_entries", rows("entry_ancestors") + rows("entries"))
    insert_rows(conn, "song_artists", rows("credits"))
    insert_rows(conn, "work_queue", rows("history"))
    insert_rows(conn, "library_stats_cache", rows("cache"))
    conn.commit()
    conn.execute("PRAGMA foreign_keys=ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise AssertionError("Foreign keys did not enable after fixture commit")
    fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
    if fk_errors:
        conn.close()
        raise AssertionError(f"Fixture violates foreign keys: {fk_errors[:20]}")
    if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise AssertionError("Fixture quick_check failed")
    for trigger in rows("live_triggers"):
        conn.execute(trigger["sql"])
    conn.commit()
    return conn, sorted(item["name"] for item in bundle["schema"] if item["type"] == "table")


def run_transaction(conn, statements):
    conn.execute("BEGIN")
    try:
        for statement in statements:
            conn.execute(statement)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def expect_reject(conn, statements, tables, name, mutate=None):
    if mutate:
        mutate(conn)
        conn.commit()
    before = snapshot(conn, tables)
    try:
        run_transaction(conn, statements)
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError(f"{name} did not fail closed")
    if snapshot(conn, tables) != before:
        raise AssertionError(f"{name} left partial writes")


def replace_rows(conn, result, table, key, additions):
    columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]
    targets = {row[key] for row in additions}
    result[table] = [row for row in result[table] if dict(zip(columns, row)).get(key) not in targets]
    defaults = {}
    for info in conn.execute(f'PRAGMA table_info("{table}")'):
        if info[4] is not None:
            defaults[info[1]] = conn.execute(f"SELECT {info[4]}").fetchone()[0]
    result[table].extend(tuple(item.get(column, defaults.get(column)) for column in columns) for item in additions)


def expected_afterimage(conn, before, tables, expected):
    out = {name: list(rows) for name, rows in before.items()}
    for table, key, field in (
        ("albums", "id", "album"), ("song_masters", "id", "masters"),
        ("song_instances", "id", "instances"), ("storage_entries", "id", "entries"),
        ("storage_objects", "id", "new_objects"), ("artists", "id", "new_artist"),
        ("song_artists", "song_id", "credits"), ("library_stats_cache", "id", "cache"),
    ):
        replace_rows(conn, out, table, key, expected[field])
    for table in out:
        out[table].sort(key=lambda row: json.dumps(row, ensure_ascii=True, default=str))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--capture-dir", type=Path, required=True)
    parser.add_argument("--capture-stem", required=True)
    parser.add_argument("--referenced-artist-stem", required=True)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    apply_raw = (args.package_dir / "apply.sql").read_bytes()
    rollback_raw = (args.package_dir / "rollback.sql").read_bytes()
    apply, rollback = split_sql(apply_raw), split_sql(rollback_raw)
    exports = load(args.package_dir / "guard_exports.json")
    readonly_path = args.package_dir / "readonly_guard_queries.json"
    readonly = load(readonly_path)
    if exports["apply_sha256"] != hashlib.sha256(apply_raw).hexdigest() or exports["rollback_sha256"] != hashlib.sha256(rollback_raw).hexdigest():
        raise AssertionError("Guard exports do not match frozen SQL")
    if readonly["apply_sha256"] != exports["apply_sha256"] or readonly["rollback_sha256"] != exports["rollback_sha256"]:
        raise AssertionError("Read-only guard SQL is not pinned to the package")
    for query in readonly["queries"]:
        if hashlib.sha256(query["sql"].encode("utf-8")).hexdigest() != query["sql_sha256"]:
            raise AssertionError("Read-only guard checksum mismatch")

    def guards(conn, kinds):
        for query in readonly["queries"]:
            if query["kind"] in kinds and conn.execute(query["sql"]).fetchall() != [(1,)]:
                raise AssertionError(f"Read-only guard failed: {query['name']}")

    trigger_rows = load(args.capture_dir / f"{args.capture_stem}_live_triggers.json")["rows"]
    if len(trigger_rows) != 20:
        raise AssertionError("Expected all 20 current triggers")
    bundle = load(args.bundle)
    tables = sorted(item["name"] for item in bundle["schema"] if item["type"] == "table")
    with tempfile.TemporaryDirectory() as temp:
        db_path = Path(temp) / "fixture.sqlite"
        conn, table_names = make_fixture(db_path, args.bundle, args.capture_dir, args.capture_stem, args.referenced_artist_stem)
        if table_names != tables:
            raise AssertionError("Fixture table set differs from the captured bundle")
        conn.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
        conn.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
        if conn.getlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH) != 100_000 or conn.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) != 100:
            raise AssertionError("SQLite limits did not take effect")
        before = snapshot(conn, table_names)
        guards(conn, {"pre"})
        run_transaction(conn, apply)
        guards(conn, {"post", "rollback"})
        after = snapshot(conn, table_names)
        expected = expected_afterimage(conn, before, table_names, exports["expected_afterimage"])
        if after != expected:
            changed = [table for table in tables if after[table] != expected[table]]
            raise AssertionError(f"Full expected-afterimage mismatch: {changed}")
        if conn.execute("PRAGMA foreign_key_check").fetchall() or conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise AssertionError("Post-apply integrity failed")
        rollback_tail = "INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('late-rollback-failure','metadata','{}','guard_failed',1);"
        expect_reject(conn, rollback + [rollback_tail], table_names, "late rollback failure")
        run_transaction(conn, rollback)
        if snapshot(conn, table_names) != before:
            raise AssertionError("Rollback did not restore the complete fixture")
        conn.close()

        new_object = exports["expected_afterimage"]["new_objects"][0]
        instance = exports["expected_afterimage"]["instances"][0]
        negative_cases = [
            ("stale-album", lambda db: db.execute("UPDATE albums SET name='stale' WHERE id=?", (exports["expected_afterimage"]["album"][0]["id"],))),
            ("new-key-collision", lambda db: db.execute("INSERT INTO storage_objects(id,physical_key,suffix,content_type,size,etag,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", (new_object["id"], new_object["physical_key"], new_object["suffix"], new_object["content_type"], 1, "collision"))),
            ("claimed-job", lambda db: db.execute("INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('fixture-claimed','metadata',?,'claimed',1)", (json.dumps({"instanceId": instance["id"]}),))),
        ]
        for name, mutate in negative_cases:
            case, case_tables = make_fixture(Path(temp) / f"{name}.sqlite", args.bundle, args.capture_dir, args.capture_stem, args.referenced_artist_stem)
            case.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
            case.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
            expect_reject(case, apply, case_tables, name, mutate)
            case.close()

        late, late_tables = make_fixture(Path(temp) / "late.sqlite", args.bundle, args.capture_dir, args.capture_stem, args.referenced_artist_stem)
        late.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
        late.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
        late_before = snapshot(late, late_tables)
        invalid = "INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('late-apply-failure','metadata','{}','guard_failed',1);"
        expect_reject(late, apply + [invalid], late_tables, "late apply failure")
        if snapshot(late, late_tables) != late_before:
            raise AssertionError("Late apply failure was not atomic")
        late.close()

    receipt = {
        "status": "PASS", "production_writes": 0, "tables": len(tables), "triggers": 20,
        "apply_sha256": hashlib.sha256(apply_raw).hexdigest(), "rollback_sha256": hashlib.sha256(rollback_raw).hexdigest(),
        "pre_guards": sum(row["kind"] == "pre" for row in readonly["queries"]),
        "post_guards": sum(row["kind"] == "post" for row in readonly["queries"]),
        "rollback_guards": sum(row["kind"] == "rollback" for row in readonly["queries"]),
        "foreign_keys_after_fixture_commit": 1, "quick_check": "ok", "fk_check": "empty",
        "sql_byte_join": "PASS", "individual_sql_length_limit": 100000, "expression_depth_limit": 100,
        "expected_afterimage_all_tables": "PASS", "exact_full_rollback": "PASS",
        "stale_album_rejection": "PASS", "key_collision_rejection": "PASS", "claimed_job_rejection": "PASS",
        "late_apply_failure_atomic": "PASS", "late_rollback_failure_atomic": "PASS",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(json.dumps(receipt, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
    print(json.dumps(receipt, ensure_ascii=True))


if __name__ == "__main__":
    main()
