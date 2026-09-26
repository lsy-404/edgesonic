import re
import sqlite3
import sys
from pathlib import Path


sql = Path(sys.argv[1]).read_text(encoding="utf-8")
group_count = int(sys.argv[2]) if len(sys.argv) > 2 else 4
member_count = int(sys.argv[3]) if len(sys.argv) > 3 else 8
track_count = int(sys.argv[4]) if len(sys.argv) > 4 else 77
stale_album = sys.argv[5] if len(sys.argv) > 5 else "al-4c6df4d0bc"
occupied_album = sys.argv[6] if len(sys.argv) > 6 else "al-9180eaf495"
blocks = re.findall(
    r"WITH expected\(id, name, year, song_count, cover_r2_key, sort_order\) AS \(\s*(VALUES.*?)\)\s*INSERT",
    sql,
    re.DOTALL,
)
assert len(blocks) == group_count


def make_db():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(
        """
        CREATE TABLE albums(id TEXT PRIMARY KEY, name TEXT, year INTEGER, song_count INTEGER, cover_r2_key TEXT);
        CREATE TABLE song_masters(id TEXT PRIMARY KEY, album_id TEXT);
        CREATE TABLE song_instances(id TEXT PRIMARY KEY, master_id TEXT, missing INTEGER);
        CREATE TABLE album_display_groups(id TEXT PRIMARY KEY, display_name TEXT, sort_name TEXT);
        CREATE TABLE album_display_group_members(
          group_id TEXT NOT NULL, album_id TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL,
          PRIMARY KEY(group_id, album_id),
          FOREIGN KEY(group_id) REFERENCES album_display_groups(id),
          FOREIGN KEY(album_id) REFERENCES albums(id)
        );
        """
    )
    for block in blocks:
        rows = db.execute(
            "WITH expected(id,name,year,song_count,cover_r2_key,sort_order) AS ("
            + block
            + ") SELECT id,name,year,song_count,cover_r2_key FROM expected"
        ).fetchall()
        for album_id, name, year, count, cover in rows:
            db.execute("INSERT INTO albums VALUES(?,?,?,?,?)", (album_id, name, year, count, cover))
            for index in range(count):
                master_id = f"{album_id}-{index}"
                db.execute("INSERT INTO song_masters VALUES(?,?)", (master_id, album_id))
                db.execute("INSERT INTO song_instances VALUES(?,?,0)", (f"si-{master_id}", master_id))
    db.commit()
    return db


positive = make_db()
positive.executescript("BEGIN;" + sql + "COMMIT;")
assert positive.execute("SELECT COUNT(*) FROM album_display_groups").fetchone()[0] == group_count
assert positive.execute("SELECT COUNT(*) FROM album_display_group_members").fetchone()[0] == member_count
assert positive.execute("SELECT COUNT(*) FROM song_masters").fetchone()[0] == track_count

stale = make_db()
stale.execute("UPDATE albums SET song_count = song_count + 1 WHERE id = ?", (stale_album,))
stale.commit()
try:
    stale.executescript("BEGIN;" + sql + "COMMIT;")
except sqlite3.IntegrityError:
    stale.rollback()
else:
    raise AssertionError("stale album snapshot was accepted")
assert stale.execute("SELECT COUNT(*) FROM album_display_groups").fetchone()[0] == 0
assert stale.execute("SELECT COUNT(*) FROM album_display_group_members").fetchone()[0] == 0

occupied = make_db()
occupied.execute("INSERT INTO album_display_groups VALUES ('existing','existing',NULL)")
occupied.execute(
    "INSERT INTO album_display_group_members VALUES ('existing',?,0)", (occupied_album,)
)
occupied.commit()
try:
    occupied.executescript("BEGIN;" + sql + "COMMIT;")
except sqlite3.IntegrityError:
    occupied.rollback()
else:
    raise AssertionError("occupied album was accepted")
assert occupied.execute("SELECT COUNT(*) FROM album_display_groups").fetchone()[0] == 1
assert occupied.execute("SELECT COUNT(*) FROM album_display_group_members").fetchone()[0] == 1

print(f"positive: {group_count} groups, {member_count} memberships; stale and occupied: atomic rollback")
