import hashlib
import json
import sqlite3
import argparse
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--snapshot", type=Path, required=True)
parser.add_argument("--capture", type=Path, required=True)
parser.add_argument("--manifest", type=Path, required=True)
parser.add_argument("--apply", type=Path, required=True)
parser.add_argument("--rollback", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
SNAPSHOT, CAPTURE, MANIFEST, APPLY, ROLLBACK = (
    args.snapshot, args.capture, args.manifest, args.apply, args.rollback
)

snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
capture = json.loads(CAPTURE.read_text(encoding="utf-8"))
cache_capture = capture
manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
assert capture["production_writes"] == 0
assert hashlib.sha256(APPLY.read_bytes()).hexdigest() == manifest["apply_sha256"]
assert hashlib.sha256(ROLLBACK.read_bytes()).hexdigest() == manifest["rollback_sha256"]

def statements(raw):
    text = raw.decode("utf-8")
    out, pending = [], ""
    for line in text.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            if pending.strip():
                out.append(pending)
            pending = ""
    if pending.strip():
        raise AssertionError("unfinished SQL tail")
    assert "".join(out).encode("utf-8") == raw
    return out

apply_raw, rollback_raw = APPLY.read_bytes(), ROLLBACK.read_bytes()
apply_stmts, rollback_stmts = statements(apply_raw), statements(rollback_raw)
assert max(len(s.encode("utf-8")) for s in apply_stmts + rollback_stmts) < 100_000
table_ddls = {r["name"]: r["sql"] for r in snap["rows"]["tables"] if not r["name"].startswith("sqlite_") and r.get("sql") and r["sql"].lstrip().upper().startswith(("CREATE TABLE", "CREATE VIRTUAL TABLE"))}
trigger_ddls = {r["name"]: r["sql"] for r in snap["rows"]["triggers"]}
assert len(table_ddls) == 130 and len(trigger_ddls) == 20

def fixture():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    c.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 100_000)
    c.execute("PRAGMA foreign_keys=OFF")
    for ddl in table_ddls.values():
        c.execute(ddl)
    for ddl in trigger_ddls.values():
        c.execute(ddl)
    actual = {r["name"]: r["sql"] for r in c.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'")}
    assert actual == trigger_ddls
    for row in capture["empty_album_rows"]:
        cols = list(row)
        c.execute(f"INSERT INTO albums({','.join(cols)}) VALUES({','.join('?' for _ in cols)})", [row[k] for k in cols])
    for row in capture["references"].get("historical_master_backups", []):
        table = row["source_table"]
        value = {k: v for k, v in row.items() if k != "source_table"}
        cols = list(value)
        c.execute(f"INSERT INTO \"{table}\"({','.join(cols)}) VALUES({','.join('?' for _ in cols)})", [value[k] for k in cols])
    cache = cache_capture["cache"]
    c.execute("INSERT INTO library_stats_cache(id,artists,albums,songs,updated_at,dirty) VALUES(?,?,?,?,?,?)", [cache[k] for k in ("id", "artists", "albums", "songs", "updated_at", "dirty")])
    c.commit()
    c.execute("PRAGMA foreign_keys=ON")
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert not c.execute("PRAGMA foreign_key_check").fetchall()
    return c

def snapshot(c):
    out = {}
    names = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    for table in names:
        cols = [r[1] for r in c.execute(f'PRAGMA table_info("{table}")')]
        rows = [dict(zip(cols, r)) for r in c.execute(f'SELECT * FROM "{table}"')]
        out[table] = sorted(rows, key=lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return out

def run(c, sql_statements):
    for stmt in sql_statements:
        c.execute(stmt)

def expect_atomic_failure(c, sql_statements):
    before = snapshot(c)
    c.execute("BEGIN")
    try:
        run(c, sql_statements)
        c.commit()
    except sqlite3.DatabaseError:
        c.rollback()
    else:
        raise AssertionError("fail-closed SQL unexpectedly committed")
    assert snapshot(c) == before

c = fixture()
before = snapshot(c)
c.execute("BEGIN")
run(c, apply_stmts)
after = snapshot(c)
expected = json.loads(json.dumps(before))
target_ids = set(manifest["album_ids"])
expected["albums"] = [r for r in expected["albums"] if r["id"] not in target_ids]
for row in expected["library_stats_cache"]:
    row["dirty"] = 1
assert after == expected
assert not c.execute("PRAGMA foreign_key_check").fetchall()
assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"

# A late constraint error must undo both restoration statements and cache changes.
postapply = snapshot(c)
late = sqlite3.complete_statement("INSERT INTO work_queue(id,task_type,payload,status) VALUES('bad','test','{}','guard_failed');")
assert late
try:
    c.execute("SAVEPOINT late_rollback")
    run(c, rollback_stmts)
    c.execute("INSERT INTO work_queue(id,task_type,payload,status) VALUES('bad','test','{}','guard_failed')")
    c.execute("RELEASE late_rollback")
except sqlite3.DatabaseError:
    c.execute("ROLLBACK TO late_rollback")
    c.execute("RELEASE late_rollback")
assert snapshot(c) == postapply

c.execute("SAVEPOINT normal_rollback")
run(c, rollback_stmts)
assert snapshot(c) == before
c.execute("RELEASE normal_rollback")
c.commit()
assert not c.execute("PRAGMA foreign_key_check").fetchall()
assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"

# A queued job containing an exact album ID is an active reference and blocks deletion.
c.execute("INSERT INTO work_queue(id,task_type,payload,status) VALUES(?,?,?,?)", ("candidate-job", "metadata", json.dumps({"album_id": manifest["album_ids"][0]}), "queued"))
c.commit()
expect_atomic_failure(c, apply_stmts)
c.execute("DELETE FROM work_queue WHERE id='candidate-job'")
c.commit()

# A stale full album row also blocks deletion.
c.execute("UPDATE albums SET name=name || ' changed' WHERE id=?", (manifest["album_ids"][0],))
c.commit()
expect_atomic_failure(c, apply_stmts)

receipt = {"status": "PASS", "capture_sha256": hashlib.sha256(CAPTURE.read_bytes()).hexdigest(),
           "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
           "manifest_sha256": hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
           "apply_sha256": hashlib.sha256(apply_raw).hexdigest(), "rollback_sha256": hashlib.sha256(rollback_raw).hexdigest(),
           "tables": len(table_ddls), "triggers": len(trigger_ddls), "foreign_keys": 1,
           "albums_retired": len(target_ids), "apply_statements": len(apply_stmts), "rollback_statements": len(rollback_stmts),
           "max_statement_bytes": max(len(s.encode("utf-8")) for s in apply_stmts + rollback_stmts),
           "expression_depth_limit": 100, "sql_length_limit": 100000,
           "exact_all_table_post_snapshot": True, "rollback_exact": True,
           "late_failure_atomic": True, "active_job_negative": True, "stale_row_negative": True}
receipt_path = args.out
receipt_path.parent.mkdir(parents=True, exist_ok=True)
receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps({"receipt": str(receipt_path), **receipt}, ensure_ascii=False, indent=2))
