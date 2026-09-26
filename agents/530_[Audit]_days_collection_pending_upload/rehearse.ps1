param([switch]$SeedOnly)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$config = Join-Path $root 'test\530_summer_days_wav\wrangler.toml'
$persist = Join-Path $root 'test\530_summer_days_wav\.wrangler\state'
$fixture = Join-Path $root 'test\530_summer_days_wav\fixture.sql'
$candidate = Join-Path $PSScriptRoot 'summer_wav_apply.sql'
$rows = @(((Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'production_inventory.json') | ConvertFrom-Json).results | Where-Object { $_.path -like 'Days幻梦年华乐团合集/2-Summer Days/WAV（无损）/*' }))
$sql = @"
PRAGMA foreign_keys=ON;
CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_name TEXT,year INTEGER,genre TEXT,cover_r2_key TEXT,song_count INTEGER DEFAULT 0,duration INTEGER DEFAULT 0,size INTEGER DEFAULT 0,compilation INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER);
CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT NOT NULL,artist_id TEXT,title TEXT NOT NULL,track INTEGER,disc INTEGER,duration INTEGER,updated_at INTEGER);
CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT NOT NULL,source_id TEXT,source_type TEXT,suffix TEXT,missing INTEGER,tag_scanned INTEGER,storage_object_id TEXT,size INTEGER);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT);
CREATE TABLE storage_entries(id TEXT PRIMARY KEY,instance_id TEXT,object_id TEXT,parent_id TEXT,path TEXT,kind TEXT);
CREATE TABLE album_display_groups(id TEXT PRIMARY KEY,display_name TEXT,sort_name TEXT,created_at INTEGER,updated_at INTEGER);
CREATE TABLE album_display_group_members(group_id TEXT,album_id TEXT UNIQUE,sort_order INTEGER,PRIMARY KEY(group_id,album_id));
CREATE TABLE work_queue(id TEXT PRIMARY KEY,task_type TEXT,payload TEXT,status TEXT CHECK(status IN ('queued','running','done')),created_at INTEGER);
INSERT INTO albums(id,name,sort_name,year,song_count,duration,size) VALUES('pending-uploads','Pending Uploads','pending uploads',2012,641,141395,24700222725),('al-2b21b237dc','Summer Days','summer days',2012,7,0,81470371);
"@
foreach ($row in $rows) {
  $master = "'$($row.master_id.Replace("'", "''"))'"; $instance = "'$($row.instance_id.Replace("'", "''"))'"; $object = "'$($row.object_id.Replace("'", "''"))'"; $entry = "'$($row.entry_id.Replace("'", "''"))'"; $parent = "'$($row.parent_id.Replace("'", "''"))'"; $path = "'$($row.path.Replace("'", "''"))'"; $key = "'$($row.physical_key.Replace("'", "''"))'"; $title = "'$($row.title.Replace("'", "''"))'"
  $sql += "INSERT INTO song_masters(id,album_id,artist_id,title,track,disc,duration) VALUES($master,'pending-uploads','unknown-artist',$title,NULL,NULL,$($row.duration));`n"
  $sql += "INSERT INTO song_instances(id,master_id,source_id,source_type,suffix,missing,tag_scanned,storage_object_id,size) VALUES($instance,$master,'r2-local','original','wav',0,1,$object,$($row.size));`n"
  $sql += "INSERT INTO storage_objects(id,physical_key) VALUES($object,$key);`n"
  $sql += "INSERT INTO storage_entries(id,instance_id,object_id,parent_id,path,kind) VALUES($entry,$instance,$object,$parent,$path,'file');`n"
}
$sql | Set-Content -LiteralPath $fixture -Encoding utf8
Remove-Item -LiteralPath $persist -Recurse -Force -ErrorAction SilentlyContinue
& npx wrangler d1 execute summer-days-wav-rehearsal --local --persist-to $persist --config $config --file $fixture
if ($SeedOnly) { exit 0 }
& npx wrangler d1 execute summer-days-wav-rehearsal --local --persist-to $persist --config $config --file $candidate
& npx wrangler d1 execute summer-days-wav-rehearsal --local --persist-to $persist --config $config --command "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-summer-days-wav') AS wav_tracks,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='adg-summer-days') AS display_members;"
