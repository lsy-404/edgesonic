import json,sqlite3,sys
from pathlib import Path
base=Path('agents/513_[Operations]_pending_upload_backfill'); map_file=base/(sys.argv[1] if len(sys.argv)>1 else 'candidate_map.json'); batch_root=base/(sys.argv[2] if len(sys.argv)>2 else 'batches'); rows=json.load(open(map_file,encoding='utf-8')); batches=sorted((batch_root/'apply').glob('*.sql')); preflight_files=sorted((batch_root/'preflight').glob('*.sql')); rbs=sorted((batch_root/'rollback').glob('*.sql')); candidate_ids=','.join("'"+x['master_id'].replace("'","''")+"'" for x in rows); target_ids=','.join("'"+x['target_album_id'].replace("'","''")+"'" for x in rows); targets={x['target_album_id'] for x in rows}
def dbmake():
 c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row; c.executescript('''
 CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,created_at INTEGER,updated_at INTEGER,song_count INTEGER DEFAULT 0,size INTEGER DEFAULT 0,year INTEGER,genre TEXT,cover_r2_key TEXT,compilation INTEGER DEFAULT 0);
 CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT,title TEXT,track INTEGER,disc INTEGER,updated_at INTEGER);
 CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,missing INTEGER,tag_scanned INTEGER,suffix TEXT,storage_object_id TEXT,size INTEGER);
 CREATE TABLE storage_objects(id TEXT PRIMARY KEY);
 CREATE TABLE storage_entries(id TEXT PRIMARY KEY,instance_id TEXT,kind TEXT,source_id TEXT,parent_id TEXT,object_id TEXT,path TEXT,display_name TEXT);
 CREATE TABLE album_display_group_members(album_id TEXT); CREATE TABLE annotations(item_type TEXT,item_id TEXT);
 CREATE TABLE work_queue(id TEXT,task_type TEXT,payload TEXT,status TEXT CHECK(status IN ('queued','claimed','completed','failed','canceled')),created_at INTEGER); CREATE TABLE lyrics(master_id TEXT); CREATE TABLE playlists(master_id TEXT);
 ''')
 c.execute("INSERT INTO albums(id,name,song_count,size) VALUES('pending-uploads','Pending',?,0)",(len(rows),))
 c.execute("INSERT INTO albums(id,name,song_count,size) VALUES('al-cb52162ace','2024 virtual singer party',1,100)")
 for i,r in enumerate(rows):
  c.execute('INSERT INTO song_masters VALUES(?,?,?,?,?,0)',(r['master_id'],'pending-uploads',r['title_snapshot'],r['track_snapshot'],r['disc_snapshot']))
  c.execute('INSERT INTO song_instances VALUES(?,?,?,?,?,?,?,?,?)',(r['instance_id'],r['master_id'],r['source_id'],'original',0,1,r['suffix'],r['storage_object_id'],100+i))
  c.execute('INSERT OR IGNORE INTO storage_objects VALUES(?)',(r['storage_object_id'],))
  c.execute('INSERT INTO storage_entries VALUES(?,?,?,?,?,?,?,?)',(r['entry_id'],r['instance_id'],'file',r['source_id'],r['parent_id'],r['storage_object_id'],r['path'],r['display_name']))
 # 29 lyrics, 868 completed queue records, and 60 non-file sidecars are preservation sentinels.
 for i in range(29):c.execute('INSERT INTO lyrics VALUES(?)',(rows[i]['master_id'],))
 for i in range(868):c.execute('INSERT INTO work_queue(id) VALUES(?)',(f'q{i}',))
 for i in range(60):c.execute('INSERT INTO storage_entries VALUES(?,?,?,?,?,?,?,?)',(f'sidecar{i}',rows[i]['instance_id'],'sidecar',rows[i]['source_id'],rows[i]['parent_id'],rows[i]['storage_object_id'],f"sidecar/{i}",f"sidecar{i}"))
 c.execute("INSERT INTO song_masters VALUES('sm-upload-36994a13-b28','al-cb52162ace','夏花挽浪',14,1,0)")
 c.execute("INSERT INTO song_instances VALUES('si-upload-365569c0-2ff','sm-upload-36994a13-b28','r2-local','original',0,1,'wav','obj-existing-14',100)")
 c.execute("INSERT INTO storage_objects VALUES('obj-existing-14')")
 c.execute("INSERT INTO storage_entries VALUES('se-a2f41816943b4f2197286b655a8f4f40','si-upload-365569c0-2ff','file','r2-local','se-28e502ac48a94259a7a1d017bb1454af','obj-existing-14','2024虚拟歌手夏浪派对——「创作」/wav/14 夏花挽浪.wav','14 夏花挽浪.wav')")
 return c

def runfiles(c, files):
 for p in files:
  try:c.executescript('BEGIN IMMEDIATE;\n'+p.read_text(encoding='utf-8')+'\nCOMMIT;')
  except Exception as e:
   if c.in_transaction:c.rollback()
   raise RuntimeError(f'{p.name}: {e}') from e

def counts(c):
  return (c.execute(f"select count(*) from song_masters where id IN ({candidate_ids}) AND album_id='pending-uploads'").fetchone()[0],c.execute(f"select count(*) from albums where id IN ({target_ids})").fetchone()[0],c.execute('select count(*) from lyrics').fetchone()[0],c.execute('select count(*) from work_queue').fetchone()[0],c.execute("select count(*) from storage_entries where kind='sidecar'").fetchone()[0])
# success
c=dbmake(); before=counts(c)
for p in preflight_files:
 r=c.execute(p.read_text(encoding='utf-8')).fetchone()
 assert r['expected_masters']==r['exact_pending_storage_matches']==r['metadata_snapshot_matches'],(p.name,dict(r))
 assert r['target_album_rows']==r['duplicate_title_groups']==r['duplicate_disc_track_groups']==r['unallowlisted_other_members']==0,(p.name,dict(r))
 assert r['other_album_members']==r['allowlisted_other_members'],(p.name,dict(r))
runfiles(c,batches);success=counts(c); assert success==(0,len(targets),29,868,60),success
assert c.execute(f"select sum(song_count) from albums where id IN ({target_ids})").fetchone()[0]==len(rows)
# early rollback
rbs=sorted((batch_root/'rollback').glob('*.sql'));runfiles(c,rbs);early=counts(c);assert early==(len(rows),0,29,868,60),early
# apply then simulate unrelated master/reference addition before late rollback
runfiles(c,batches); cand=next((x for x in rows if x['album_name']=='2024虚拟歌手夏浪派对——「创作」'),rows[0])
target=cand['target_album_id']; c.execute('INSERT INTO song_masters VALUES(?,?,?,?,?,0)',('external-master',target,'unrelated-title',14,1));c.execute("UPDATE albums SET cover_r2_key='covers/keep' WHERE id=?",(target,));c.execute("INSERT INTO annotations VALUES('album',?)",(target,));c.execute('INSERT INTO album_display_group_members VALUES(?)',(target,));c.commit()
rb=next(p for p in rbs if cand['target_album_id'] in p.read_text(encoding='utf-8'));runfiles(c,[rb]);late=(c.execute(f"select count(*) from song_masters where id IN ({candidate_ids}) AND album_id='pending-uploads'").fetchone()[0], c.execute('select count(*) from song_masters where album_id=?',(target,)).fetchone()[0],c.execute('select cover_r2_key from albums where id=?',(target,)).fetchone()[0],c.execute("select count(*) from annotations where item_id=?",(target,)).fetchone()[0],c.execute('select count(*) from album_display_group_members where album_id=?',(target,)).fetchone()[0]);assert late==(len([x for x in rows if x['target_album_id']==target]),1,'covers/keep',1,1),late
# stale-state rejection on independent first batch
s=dbmake(); bfile=batches[0]; import re; bmaster=re.search(r"id IN \('([^']+)'",bfile.read_text(encoding='utf-8')).group(1); s.execute("UPDATE song_masters SET album_id='other' WHERE id=?",(bmaster,));s.commit()
try:runfiles(s,[bfile]);raise AssertionError('stale batch unexpectedly succeeded')
except RuntimeError as e: assert 'CHECK constraint failed' in str(e),e
stale=s.execute('select album_id from song_masters where id=?',(bmaster,)).fetchone()[0]; assert stale=='other'
print(json.dumps({'candidate_map':map_file.name,'initial':before,'local_preflight_groups':len(preflight_files),'successful_apply':success,'early_rollback':early,'late_rollback':late,'stale_guard':'rejected atomically','batches':len(batches)},ensure_ascii=False))
