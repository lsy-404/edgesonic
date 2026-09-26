CREATE TABLE work_queue(id TEXT PRIMARY KEY,task_type TEXT,payload TEXT,status TEXT CHECK(status IN ('queued','claimed','completed','failed')),created_at INTEGER);
CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,song_count INTEGER,duration INTEGER,size INTEGER,updated_at INTEGER);
CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT,artist_id TEXT,album_artist_id TEXT,title TEXT,track INTEGER,disc INTEGER,duration INTEGER,lyrics TEXT,lyrics_rich TEXT,cover_r2_key TEXT,updated_at INTEGER);
CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,storage_uri TEXT,suffix TEXT,size INTEGER,duration INTEGER,missing INTEGER,tag_scanned INTEGER,storage_object_id TEXT,source_etag TEXT);
CREATE TABLE storage_entries(id TEXT PRIMARY KEY,source_id TEXT,parent_id TEXT,path TEXT,display_name TEXT,kind TEXT,object_id TEXT,instance_id TEXT,companion_of TEXT);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT,suffix TEXT,size INTEGER,legacy_key TEXT,etag TEXT);
