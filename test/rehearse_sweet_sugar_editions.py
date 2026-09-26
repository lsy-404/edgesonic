import hashlib
import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "agents" / "534_[Operations]_sweet_sugar_editions"
SNAPSHOT = json.loads((AUDIT / "primary_snapshot.json").read_text(encoding="utf-8"))
SQL = (AUDIT / "apply_guarded.sql").read_text(encoding="utf-8")

SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE albums(
  id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,year INTEGER,genre TEXT,
  cover_r2_key TEXT,song_count INTEGER,duration INTEGER,size INTEGER,
  compilation INTEGER,created_at INTEGER,updated_at INTEGER
);
CREATE TABLE song_masters(
  id TEXT PRIMARY KEY,album_id TEXT REFERENCES albums(id),artist_id TEXT,
  album_artist_id TEXT,title TEXT,sort_title TEXT,disc INTEGER,track INTEGER,
  duration INTEGER,genre TEXT,updated_at INTEGER
);
CREATE TABLE song_instances(
  id TEXT PRIMARY KEY,master_id TEXT REFERENCES song_masters(id),source_id TEXT,
  source_type TEXT,storage_uri TEXT,storage_object_id TEXT,suffix TEXT,
  size INTEGER,missing INTEGER,tag_scanned INTEGER
);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT,size INTEGER);
CREATE TABLE storage_entries(
  id TEXT PRIMARY KEY,source_id TEXT,parent_id TEXT,path TEXT,kind TEXT,
  instance_id TEXT REFERENCES song_instances(id),object_id TEXT REFERENCES storage_objects(id)
);
CREATE TABLE album_display_groups(
  id TEXT PRIMARY KEY,display_name TEXT,sort_name TEXT,created_at INTEGER,updated_at INTEGER
);
CREATE TABLE album_display_group_members(
  group_id TEXT REFERENCES album_display_groups(id),album_id TEXT REFERENCES albums(id),
  sort_order INTEGER,PRIMARY KEY(group_id,album_id)
);
CREATE TABLE work_queue(id TEXT PRIMARY KEY,status TEXT,payload TEXT);
"""


def seed():
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    album = SNAPSHOT["result"][1]["results"][0]
    db.execute(
        "INSERT INTO albums VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        tuple(album[k] for k in (
            "id", "name", "sort_name", "year", "genre", "cover_r2_key",
            "song_count", "duration", "size", "compilation", "created_at", "updated_at"
        )),
    )
    for row in SNAPSHOT["result"][0]["results"]:
        db.execute(
            "INSERT INTO song_masters VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            tuple(row[k] for k in (
                "master_id", "album_id", "artist_id", "album_artist_id", "title",
                "sort_title", "disc", "track", "duration", "genre"
            )) + (album["updated_at"],),
        )
        db.execute(
            "INSERT INTO storage_objects VALUES(?,?,?)",
            (row["object_id"], row["physical_key"], row["object_size"]),
        )
        db.execute(
            "INSERT INTO song_instances VALUES(?,?,?,?,?,?,?,?,?,?)",
            tuple(row[k] for k in (
                "instance_id", "instance_master_id", "source_id", "source_type",
                "storage_uri", "storage_object_id", "suffix", "instance_size",
                "missing", "tag_scanned"
            )),
        )
        db.execute(
            "INSERT INTO storage_entries VALUES(?,?,?,?,?,?,?)",
            tuple(row[k] for k in (
                "entry_id", "entry_source_id", "parent_id", "path", "kind",
                "entry_instance_id", "entry_object_id"
            )),
        )
    db.commit()
    return db


def fingerprint(db):
    return hashlib.sha256("\n".join(db.iterdump()).encode("utf-8")).hexdigest()


def run(db, late=False):
    suffix = "SELECT abs(-9223372036854775808);\n" if late else ""
    try:
        db.executescript("BEGIN;\n" + SQL + suffix + "COMMIT;")
    except sqlite3.DatabaseError:
        db.rollback()
        return False
    return True


def main():
    db = seed()
    before_objects = db.execute(
        "SELECT id,physical_key,size FROM storage_objects ORDER BY id"
    ).fetchall()
    assert run(db)
    assert db.execute(
        "SELECT id,song_count,duration,size FROM albums ORDER BY id"
    ).fetchall() == [
        ("al-1aee8da1c9", 12, 2775, 44989327),
        ("al-8b7626106c", 11, 2738, 365724208),
    ]
    assert db.execute(
        "SELECT album_id,COUNT(*),MIN(track),MAX(track),COUNT(DISTINCT track),MIN(disc),MAX(disc) FROM song_masters GROUP BY album_id ORDER BY album_id"
    ).fetchall() == [
        ("al-1aee8da1c9", 12, 1, 12, 12, 1, 1),
        ("al-8b7626106c", 11, 2, 12, 11, 1, 1),
    ]
    assert db.execute(
        "SELECT group_id,album_id,sort_order FROM album_display_group_members ORDER BY sort_order"
    ).fetchall() == [
        ("ag-sweet-sugar-editions-20260926", "al-1aee8da1c9", 0),
        ("ag-sweet-sugar-editions-20260926", "al-8b7626106c", 1),
    ]
    assert db.execute(
        "SELECT id,physical_key,size FROM storage_objects ORDER BY id"
    ).fetchall() == before_objects
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []

    for variant in ("stale_object", "active_work", "late_failure"):
        db = seed()
        if variant == "stale_object":
            db.execute(
                "UPDATE storage_objects SET physical_key='changed' WHERE id=?",
                (SNAPSHOT["result"][0]["results"][0]["object_id"],),
            )
        if variant == "active_work":
            db.execute(
                "INSERT INTO work_queue VALUES('concurrent','queued',?)",
                (json.dumps({"instanceId": SNAPSHOT["result"][0]["results"][0]["instance_id"]}),),
            )
        db.commit()
        before = fingerprint(db)
        assert not run(db, late=variant == "late_failure"), variant
        assert fingerprint(db) == before, variant
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    source = seed()
    fixture = [SCHEMA]
    for table in ("albums", "song_masters", "storage_objects", "song_instances", "storage_entries"):
        for row in source.execute(f"SELECT * FROM {table}"):
            values = ["NULL" if value is None else str(value) if isinstance(value, int)
                      else "'" + value.replace("'", "''") + "'" for value in row]
            fixture.append(f"INSERT INTO {table} VALUES({','.join(values)});")
    (AUDIT / "local_fixture.sql").write_text("\n".join(fixture) + "\n", encoding="utf-8")
    print(json.dumps({"success": True, "stale_object": True, "active_work": True, "late_failure_rollback": True}))


if __name__ == "__main__":
    main()
