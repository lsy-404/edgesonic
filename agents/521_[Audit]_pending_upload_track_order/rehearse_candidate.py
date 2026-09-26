"""Exercise the candidate's all-or-nothing update and rollback guards in SQLite."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path


def build_database(rows: list[dict]) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE song_masters (id TEXT PRIMARY KEY, album_id TEXT, track INTEGER, disc INTEGER, updated_at INTEGER)")
    db.execute("CREATE TABLE song_instances (id TEXT PRIMARY KEY, master_id TEXT, source_id TEXT, storage_object_id TEXT)")
    db.execute("CREATE TABLE storage_entries (id TEXT PRIMARY KEY, instance_id TEXT, kind TEXT, source_id TEXT, parent_id TEXT, path TEXT, display_name TEXT)")
    db.executemany(
        "INSERT INTO song_masters(id, album_id, track, disc) VALUES (?, ?, NULL, NULL)",
        [(r["master_id"], r["target_album_id"]) for r in rows],
    )
    db.executemany(
        "INSERT INTO song_instances VALUES (?, ?, ?, ?)",
        [(r["instance_id"], r["master_id"], r["source_id"], r["storage_object_id"]) for r in rows],
    )
    db.executemany(
        "INSERT INTO storage_entries VALUES (?, ?, 'file', ?, ?, ?, ?)",
        [(r["entry_id"], r["instance_id"], r["source_id"], r["parent_id"], r["path"], r["display_name"]) for r in rows],
    )
    return db


def state(db: sqlite3.Connection) -> tuple[int, int, int]:
    return db.execute(
        "SELECT COUNT(*), SUM(track IS NULL AND disc IS NULL), SUM(track IS NOT NULL AND disc=1) FROM song_masters"
    ).fetchone()


def main(artifact_dir: Path) -> None:
    rows = json.loads((artifact_dir / "snapshot_candidate.json").read_text(encoding="utf-8"))
    apply_sql = (artifact_dir / "apply_guarded.sql").read_text(encoding="utf-8")
    rollback_sql = (artifact_dir / "rollback_guarded.sql").read_text(encoding="utf-8")
    report: dict[str, object] = {"masters": len(rows), "albums": len({r['target_album_id'] for r in rows})}

    success = build_database(rows)
    success.executescript(apply_sql)
    report["success_apply"] = {"state": state(success)}
    assert state(success) == (243, 0, 243)
    success.executescript(rollback_sql)
    report["success_rollback"] = {"state": state(success)}
    assert state(success) == (243, 243, 0)

    stale = build_database(rows)
    stale.execute("UPDATE song_masters SET track=99, disc=1 WHERE id=?", (rows[0]["master_id"],))
    stale.executescript(apply_sql)
    report["stale_apply"] = {"state": state(stale), "changed_rows": stale.total_changes - (len(rows) * 3 + 1)}
    assert state(stale) == (243, 242, 1)

    late = build_database(rows)
    late.executescript(apply_sql)
    late.execute("UPDATE song_masters SET track=99 WHERE id=?", (rows[0]["master_id"],))
    late.executescript(rollback_sql)
    report["late_rollback"] = {"state": state(late), "changed_rows": late.total_changes - (len(rows) * 4 + 1)}
    assert state(late) == (243, 0, 243)

    (artifact_dir / "local_rehearsal.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
