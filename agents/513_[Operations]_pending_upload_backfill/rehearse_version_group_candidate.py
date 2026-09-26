import json
import sqlite3
from pathlib import Path

base = Path(__file__).parent
candidate = json.loads((base / "version_group_candidate.json").read_text(encoding="utf-8"))
pairs = candidate["pairs"]
canonical = candidate["canonical_page_album_id"]
fragment_ids = [x for x in candidate["page_source_albums"] if x != canonical]

def dbmake():
    db = sqlite3.connect(":memory:")
    db.executescript("""
    CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,year INTEGER,genre TEXT,cover_r2_key TEXT,song_count INTEGER,duration INTEGER,size INTEGER,compilation INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT,cover_r2_key TEXT,artist_id TEXT,album_artist_id TEXT,title TEXT,sort_title TEXT,track INTEGER,disc INTEGER,duration INTEGER,genre TEXT,compilation INTEGER,participants TEXT,lyrics TEXT,lyrics_rich TEXT,updated_at INTEGER);
    CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,missing INTEGER,tag_scanned INTEGER,suffix TEXT,storage_uri TEXT,storage_object_id TEXT,duration INTEGER,size INTEGER);
    CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT,suffix TEXT,size INTEGER);
    CREATE TABLE storage_entries(id TEXT PRIMARY KEY,instance_id TEXT,kind TEXT,source_id TEXT,parent_id TEXT,path TEXT,display_name TEXT,object_id TEXT,companion_of TEXT);
    CREATE TABLE song_artists(song_id TEXT,artist_id TEXT,position INTEGER);
    CREATE TABLE clone_id_map(source_key TEXT,item_type TEXT,remote_id TEXT,local_id TEXT);
    CREATE TABLE annotations(user_id TEXT,item_id TEXT,item_type TEXT);
    CREATE TABLE album_display_groups(id TEXT PRIMARY KEY,display_name TEXT,sort_name TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE album_display_group_members(group_id TEXT,album_id TEXT UNIQUE,sort_order INTEGER,PRIMARY KEY(group_id,album_id));
    CREATE TABLE work_queue(id TEXT PRIMARY KEY,task_type TEXT,payload TEXT,status TEXT CHECK(status IN ('queued','claimed','completed','failed','canceled')),created_at INTEGER);
    """)
    db.execute("INSERT INTO albums VALUES ('pending-uploads','Pending Uploads',NULL,NULL,NULL,'covers/pending',752,0,1,0,0,0)")
    for album in ['al-9544935a62', *candidate["page_source_albums"]]:
        a = candidate['source_albums'][album]
        db.execute("INSERT INTO albums VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", tuple(a[k] for k in ['id','name','sort_name','year','genre','cover_r2_key','song_count','duration','size','compilation']) + (0, 0))
    for row in pairs:
        for role in ("candidate", "source"):
            m = row[role]
            db.execute("INSERT INTO song_masters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)", tuple(m[k] for k in ['id','album_id','cover_r2_key','artist_id','album_artist_id','title','sort_title','track','disc','duration','genre','compilation','participants','lyrics','lyrics_rich']))
        i = row["inventory"]
        db.execute("INSERT INTO song_instances VALUES (?,?,?,?,?,?,?,?,?,?,?)", (i['instance_id'], row['candidate_master_id'], i['source_id'], i['source_type'], i['missing'], i['tag_scanned'], i['suffix'], i['storage_uri'], i['storage_object_id'], 0, i['instance_size']))
        db.execute("INSERT INTO storage_objects VALUES (?,?,?,?)", (i['storage_object_id'], i['physical_key'], i['object_suffix'], i['object_size']))
        db.execute("INSERT INTO storage_entries VALUES (?,?,?,?,?,?,?,?,?)", (i['entry_id'], i['instance_id'], 'file', i['source_id'], i['parent_id'], i['path'], i['display_name'], i['storage_object_id'], i['companion_of']))
        db.execute("INSERT INTO song_artists VALUES (?,?,0)", (row['source_master_id'], 'source-credit'))
    db.commit()
    return db

def run(db, name):
    try:
        db.executescript("BEGIN IMMEDIATE;\n" + (base / name).read_text(encoding="utf-8") + "\nCOMMIT;")
    except Exception as err:
        db.rollback()
        raise RuntimeError(str(err)) from err

def state(db):
    return {
        "pending": db.execute("SELECT count(*) FROM song_masters WHERE album_id='pending-uploads' AND id IN (%s)" % ','.join('?' * len(pairs)), [r['candidate_master_id'] for r in pairs]).fetchone()[0],
        "page_tracks": db.execute("SELECT count(*) FROM song_masters WHERE album_id=?", (canonical,)).fetchone()[0],
        "fragment_albums": db.execute("SELECT count(*) FROM albums WHERE id IN (%s)" % ','.join('?' * len(fragment_ids)), fragment_ids).fetchone()[0],
        "targets": db.execute("SELECT count(*) FROM albums WHERE id IN ('al-version-freesia-wav','al-version-pages-wav')").fetchone()[0],
        "groups": db.execute("SELECT count(*) FROM album_display_groups WHERE id IN ('ag-version-freesia','ag-version-page-interlude')").fetchone()[0],
        "credits": db.execute("SELECT count(*) FROM song_artists").fetchone()[0],
        "entries": db.execute("SELECT count(*) FROM storage_entries").fetchone()[0],
    }

db = dbmake()
initial = state(db)
run(db, "version_group_apply.sql")
applied = state(db)
assert applied == {"pending": 0, "page_tracks": 10, "fragment_albums": 0, "targets": 2, "groups": 2, "credits": 44, "entries": 22}, applied
run(db, "version_group_rollback.sql")
early = state(db)
assert early == initial, (initial, early)

stale = dbmake()
stale.execute("UPDATE song_masters SET title='changed' WHERE id=?", (pairs[0]['candidate_master_id'],))
stale.commit()
try:
    run(stale, "version_group_apply.sql")
    raise AssertionError("stale candidate unexpectedly applied")
except RuntimeError as err:
    assert "CHECK constraint failed" in str(err), err
assert state(stale) == initial

late = dbmake()
run(late, "version_group_apply.sql")
late.execute("INSERT INTO albums VALUES ('external-album','external',NULL,NULL,NULL,NULL,0,0,0,0,0,0)")
late.execute("INSERT INTO song_masters VALUES ('external-master','al-version-freesia-wav',NULL,'external',NULL,'external',NULL,1,1,NULL,NULL,0,NULL,NULL,NULL,0)")
late.execute("INSERT INTO annotations VALUES ('u','al-version-pages-wav','album')")
late.execute("INSERT INTO album_display_group_members VALUES ('ag-version-freesia','external-album',2)")
late.commit()
run(late, "version_group_rollback.sql")
late_state = state(late)
assert late_state["pending"] == 22 and late_state["page_tracks"] == 1 and late_state["fragment_albums"] == 8 and late_state["credits"] == 22 and late_state["entries"] == 22, late_state
assert late.execute("SELECT count(*) FROM song_masters WHERE id='external-master'").fetchone()[0] == 1
assert late.execute("SELECT count(*) FROM annotations WHERE item_id='al-version-pages-wav'").fetchone()[0] == 1
assert late.execute("SELECT count(*) FROM album_display_groups WHERE id='ag-version-freesia'").fetchone()[0] == 1
print(json.dumps({"initial": initial, "successful_apply": applied, "early_rollback": early, "stale_apply": "rejected atomically", "late_rollback": late_state}, ensure_ascii=False))
