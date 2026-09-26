import json, sqlite3
from pathlib import Path

repo=Path(__file__).resolve().parents[2]
snap=json.loads((repo/'agents/531_[Audit]_pending_album_identity/zhulan_primary_snapshot.json').read_text(encoding='utf-8'))
rows=snap['rows']
pending=snap['pending']
conn=sqlite3.connect(':memory:')
conn.executescript('''
CREATE TABLE artists(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_name TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_name TEXT,song_count INTEGER,duration INTEGER,size INTEGER,compilation INTEGER,created_at INTEGER,updated_at INTEGER);
CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT NOT NULL,artist_id TEXT NOT NULL,album_artist_id TEXT,title TEXT NOT NULL,track INTEGER,disc INTEGER,duration INTEGER,lyrics TEXT,lyrics_rich TEXT,cover_r2_key TEXT,updated_at INTEGER);
CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,storage_uri TEXT,storage_object_id TEXT,suffix TEXT,size INTEGER,duration INTEGER,missing INTEGER,tag_scanned INTEGER,source_etag TEXT);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT,legacy_key TEXT,size INTEGER,etag TEXT,suffix TEXT);
CREATE TABLE storage_entries(id TEXT PRIMARY KEY,source_id TEXT,parent_id TEXT,path TEXT,display_name TEXT,kind TEXT,object_id TEXT,instance_id TEXT,companion_of TEXT);
CREATE TABLE work_queue(id TEXT PRIMARY KEY,task_type TEXT,payload TEXT,status TEXT CHECK(status IN ('queued','claimed','completed','failed','canceled')),created_at INTEGER);
''')
conn.execute("INSERT INTO artists VALUES('unknown-artist','Unknown','Unknown',0,0)")
conn.execute("INSERT INTO albums VALUES('pending-uploads','Pending','Pending',?,?,?,0,0,0)",(pending['song_count'],pending['duration'],pending['size']))
track_duration=sum(r['master_duration'] or 0 for r in rows)
track_size=sum(r['instance_size'] or 0 for r in rows)
rem_duration=pending['duration']-track_duration
rem_size=pending['size']-track_size
for i in range(pending['song_count']-len(rows)):
    dur=rem_duration if i==0 else 0
    size=rem_size if i==0 else 0
    mid=f'fixture-{i:03}'
    conn.execute('INSERT INTO song_masters(id,album_id,artist_id,title,duration) VALUES(?,?,?,?,?)',(mid,'pending-uploads','unknown-artist',mid,dur))
    conn.execute('INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned) VALUES(?,?,?,?,?,?,?,?,?,?)',(f'fi-{i:03}',mid,'r2-local','original',f'r2://fixture/{mid}.wav','wav',size,dur,0,1))
conn.execute("INSERT INTO storage_entries(id,source_id,path,display_name,kind) VALUES('se-e43af23755444b1aa56d4501c7ba77d4','r2-local','蔗蓝的创作集1.0-蔗蓝（wav）','蔗蓝的创作集1.0-蔗蓝（wav）','folder')")
for r in rows:
    conn.execute('INSERT INTO song_masters(id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(r['master_id'],r['album_id'],r['artist_id'],r['album_artist_id'],r['title'],r['track'],r['disc'],r['master_duration'],r['lyrics'],r['lyrics_rich'],r['cover_r2_key']))
    conn.execute('INSERT INTO storage_objects(id,physical_key,legacy_key,size,etag,suffix) VALUES(?,?,?,?,?,?)',(r['storage_object_id'],r['physical_key'],r['legacy_key'],r['object_size'],r['object_etag'],'wav'))
    conn.execute('INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,storage_object_id,suffix,size,duration,missing,tag_scanned,source_etag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(r['instance_id'],r['master_id'],r['source_id'],r['source_type'],r['storage_uri'],r['storage_object_id'],r['suffix'],r['instance_size'],r['instance_duration'],r['missing'],r['tag_scanned'],r['source_etag']))
    conn.execute('INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of) VALUES(?,?,?,?,?,?,?,?,?)',(r['entry_id'],'r2-local',r['parent_id'],r['path'],r['display_name'],r['kind'],r['object_id'],r['instance_id'],r['companion_of']))
conn.execute("INSERT INTO storage_objects(id,physical_key,legacy_key,size,etag,suffix) VALUES('obj_568cc33144589d95','objects/obj_568cc33144589d95.cue',NULL,4649,NULL,'cue')")
conn.execute("INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id) VALUES('se-9c7a6e8fe38949a6b6a231dafc7ccad1','r2-local','se-e43af23755444b1aa56d4501c7ba77d4','蔗蓝的创作集1.0-蔗蓝（wav）/蔗蓝的创作集1.0.cue','蔗蓝的创作集1.0.cue','file','obj_568cc33144589d95')")
(repo/'test/zhulan_rehearsal/fixture.sql').write_text('\n'.join(x for x in conn.iterdump() if x.startswith(('CREATE TABLE','INSERT INTO')))+'\n',encoding='utf-8')
