$ErrorActionPreference='Stop'
$base=Split-Path -Parent $PSCommandPath
$rows=@((Get-Content -Raw -LiteralPath (Join-Path $base 'primary_scope.json')|ConvertFrom-Json)[0].results)
$q={param([string]$v) "'"+$v.Replace("'","''")+"'"}
$sql=@"
CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,year INTEGER,genre TEXT,compilation INTEGER,song_count INTEGER,duration INTEGER,size INTEGER,created_at INTEGER,updated_at INTEGER);
CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT,title TEXT,track INTEGER,disc INTEGER,updated_at INTEGER);
CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,suffix TEXT,missing INTEGER,tag_scanned INTEGER,storage_object_id TEXT,duration INTEGER,size INTEGER);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT);
CREATE TABLE storage_entries(id TEXT PRIMARY KEY,kind TEXT,display_name TEXT,instance_id TEXT,object_id TEXT,parent_id TEXT,path TEXT);
CREATE TABLE annotations(item_type TEXT,item_id TEXT);
CREATE TABLE playlist_songs(song_master_id TEXT);
CREATE TABLE song_artists(song_id TEXT,artist_id TEXT);
CREATE TABLE album_display_groups(id TEXT PRIMARY KEY,display_name TEXT,sort_name TEXT);
CREATE TABLE album_display_group_members(group_id TEXT,album_id TEXT,sort_order INTEGER);
CREATE TABLE work_queue(id TEXT PRIMARY KEY,task_type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('queued','claimed','completed','failed','canceled')),created_at INTEGER NOT NULL);
INSERT INTO albums(id,name,sort_name,year,genre,compilation,song_count,duration,size) VALUES('pending-uploads','pending-uploads','pending-uploads',NULL,NULL,0,25,0,0),('al-0494f8ac9c','Find-Zero','find-zero',NULL,'未知流派',0,14,0,0);
"@
foreach($folder in @($rows | Group-Object parent_id)){
 $sample=$folder.Group[0]
 $folderName=& $q ([string]$sample.disc_folder)
 $folderPath=& $q ('Find-Zero/'+[string]$sample.disc_folder)
 $folderId=& $q ([string]$sample.parent_id)
 $sql+="INSERT INTO storage_entries(id,kind,display_name,parent_id,path) VALUES($folderId,'directory',$folderName,NULL,$folderPath);`n"
}
foreach($r in $rows){
 $mid=& $q ([string]$r.master_id); $iid=& $q ([string]$r.instance_id); $oid=& $q ([string]$r.object_id); $eid=& $q ([string]$r.entry_id); $parentSql=& $q ([string]$r.parent_id); $title=& $q ([string]$r.title); $key=& $q ([string]$r.physical_key); $path=& $q ([string]$r.path)
 $sql+="INSERT INTO song_masters(id,album_id,title) VALUES($mid,'pending-uploads',$title);`n"
 $sql+="INSERT INTO song_instances VALUES($iid,$mid,'r2-local','original','wav',0,1,$oid,0,$($r.size));`n"
 $sql+="INSERT INTO storage_objects VALUES($oid,$key);`n"
 $sql+="INSERT INTO storage_entries(id,kind,instance_id,object_id,parent_id,path) VALUES($eid,'file',$iid,$oid,$parentSql,$path);`n"
}
$sql.TrimEnd() | Set-Content -LiteralPath (Join-Path $base 'fixture.sql') -Encoding utf8
$stale=$sql+"UPDATE song_masters SET title='stale' WHERE id='$($rows[0].master_id)';"
$stale | Set-Content -LiteralPath (Join-Path $base 'fixture_stale.sql') -Encoding utf8
"INSERT INTO annotations VALUES('song','$($rows[0].master_id)');" | Set-Content -LiteralPath (Join-Path $base 'late_reference.sql') -Encoding utf8
