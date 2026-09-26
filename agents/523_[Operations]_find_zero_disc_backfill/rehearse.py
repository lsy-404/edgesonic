import json
import pathlib
import sqlite3

base = pathlib.Path(__file__).parent
scope = json.loads((base / 'primary_scope.json').read_text(encoding='utf-8-sig'))
rows = scope[0]['results']
apply_sql = (base / 'apply.sql').read_text(encoding='utf-8-sig')
rollback_sql = (base / 'rollback.sql').read_text(encoding='utf-8-sig')

schema = '''
PRAGMA foreign_keys=ON;
CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,genre TEXT,compilation INTEGER,song_count INTEGER,duration INTEGER,size INTEGER,updated_at INTEGER);
CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT,title TEXT,track INTEGER,disc INTEGER,updated_at INTEGER);
CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,suffix TEXT,missing INTEGER,tag_scanned INTEGER,storage_object_id TEXT,duration INTEGER,size INTEGER);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT);
CREATE TABLE storage_entries(id TEXT PRIMARY KEY,kind TEXT,instance_id TEXT,object_id TEXT,path TEXT);
CREATE TABLE annotations(item_type TEXT,item_id TEXT);
CREATE TABLE playlist_songs(song_master_id TEXT);
CREATE TABLE album_display_groups(id TEXT PRIMARY KEY,display_name TEXT,sort_name TEXT);
CREATE TABLE album_display_group_members(group_id TEXT,album_id TEXT,sort_order INTEGER);
'''

def fixture():
    con = sqlite3.connect(':memory:')
    con.executescript(schema)
    con.execute("INSERT INTO albums(id,name,song_count,duration,size) VALUES('pending-uploads','pending-uploads',25,0,0)")
    con.execute("INSERT INTO albums(id,name,song_count,duration,size) VALUES('al-0494f8ac9c','Find-Zero',14,0,0)")
    for r in rows:
        con.execute("INSERT INTO song_masters(id,album_id,title) VALUES(?,?,?)", (r['master_id'], 'pending-uploads', r['title']))
        con.execute("INSERT INTO song_instances VALUES(?,?,?,?,?,?,?,?,?,?)", (r['instance_id'], r['master_id'], 'r2-local', 'original', 'wav', 0, 1, r['object_id'], 0, r['size']))
        con.execute("INSERT INTO storage_objects VALUES(?,?)", (r['object_id'], r['physical_key']))
        con.execute("INSERT INTO storage_entries VALUES(?,?,?,?,?)", (r['entry_id'], 'file', r['instance_id'], r['object_id'], r['path']))
    return con

def rejected(sql, change):
    con = fixture()
    change(con)
    try:
        con.executescript(sql)
    except sqlite3.IntegrityError:
        return True
    raise AssertionError('guard accepted an invalid state')

con = fixture()
con.executescript(apply_sql)
assert con.execute("SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav'").fetchone()[0] == 25
assert con.execute("SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav' AND disc=1").fetchone()[0] == 14
assert con.execute("SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav' AND disc=2").fetchone()[0] == 11
assert con.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0] == 25
assert con.execute("SELECT COUNT(*) FROM storage_entries").fetchone()[0] == 25
con.execute("DROP TABLE candidate")
con.execute("DROP TABLE assertion")
con.executescript(rollback_sql)
assert con.execute("SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads' AND track IS NULL AND disc IS NULL").fetchone()[0] == 25
assert con.execute("SELECT COUNT(*) FROM albums WHERE id='al-find-zero-wav'").fetchone()[0] == 0
assert con.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0] == 25
assert rejected(apply_sql, lambda db: db.execute("UPDATE song_masters SET title='stale' WHERE id=?", (rows[0]['master_id'],)))
late = fixture()
late.executescript(apply_sql)
late.execute("INSERT INTO annotations VALUES('song',?)", (rows[0]['master_id'],))
late.execute("DROP TABLE candidate")
late.execute("DROP TABLE assertion")
try:
    late.executescript(rollback_sql)
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError('late rollback guard accepted a new reference')
print('success, stale rejection, and late rollback rejection passed')
