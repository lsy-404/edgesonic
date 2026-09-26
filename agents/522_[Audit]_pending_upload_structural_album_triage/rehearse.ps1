$apply = (Resolve-Path -LiteralPath "$PSScriptRoot\apply_distortion_overdrive.sql").Path
$rollback = (Resolve-Path -LiteralPath "$PSScriptRoot\rollback_distortion_overdrive.sql").Path
$sqlite = 'F:\OneDrive - 510V\PATH\sqlite3.exe'
$pairs = [regex]::Matches((Get-Content -Raw -LiteralPath $apply), "\('([^']+)',([12]),([0-9]+)\)") | Select-Object -First 22

function New-Seed {
  $sql = @(
    'CREATE TABLE albums(id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,year INTEGER,genre TEXT,cover_r2_key TEXT,compilation INTEGER DEFAULT 0,song_count INTEGER DEFAULT 0,size INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER);',
    'CREATE TABLE song_masters(id TEXT PRIMARY KEY,album_id TEXT,track INTEGER,disc INTEGER,updated_at INTEGER);',
    'CREATE TABLE song_instances(id TEXT PRIMARY KEY,master_id TEXT,source_id TEXT,source_type TEXT,missing INTEGER,tag_scanned INTEGER,suffix TEXT,size INTEGER);',
    'CREATE TABLE storage_entries(id TEXT PRIMARY KEY,instance_id TEXT,kind TEXT,parent_id TEXT,path TEXT);',
    "CREATE TABLE work_queue(id TEXT,task_type TEXT,payload TEXT,status TEXT CHECK(status IN ('queued','claimed','completed','failed','canceled')),created_at INTEGER);",
    'CREATE TABLE album_display_group_members(album_id TEXT);',
    'CREATE TABLE annotations(item_type TEXT,item_id TEXT);',
    "INSERT INTO albums(id,name) VALUES('pending-uploads','Pending Uploads');"
  )
  $n = 0
  foreach ($pair in $pairs) {
    $n++; $id=$pair.Groups[1].Value; $disc=$pair.Groups[2].Value
    $parent = if ($disc -eq '1') { 'se-4ebf55c2760f4094ac9b4834ea1ac2f6' } else { 'se-675f777b8c4d4ea987bf9d1a3500f12a' }
    $sql += "INSERT INTO song_masters VALUES('$id','pending-uploads',NULL,NULL,0);"
    $sql += "INSERT INTO song_instances VALUES('i$n','$id','r2-local','original',0,1,'wav',$n);"
    $sql += "INSERT INTO storage_entries VALUES('e$n','i$n','file','$parent','Distortion and Overdrive（2014）/$n.wav');"
  }
  $sql
}

# Stale source: one master no longer satisfies the initial pending-state guard.
$stale = New-Seed
$stale += "UPDATE song_masters SET album_id='external' WHERE id='$($pairs[0].Groups[1].Value)';"
$stale += '.bail on'
$stale += ".read $apply"
$staleOut = ($stale -join "`n" | & $sqlite ':memory:' 2>&1) -join "`n"
if ($staleOut -notmatch 'CHECK constraint failed') { throw "stale guard failed: $staleOut" }

# Late rollback: retain an outside member and references while restoring all candidates.
$late = New-Seed
$late += ".read $apply"
$late += "INSERT INTO song_masters VALUES('external-master','al-17e41d5b4f',99,3,0);"
$late += "UPDATE albums SET cover_r2_key='covers/keep' WHERE id='al-17e41d5b4f';"
$late += "INSERT INTO annotations VALUES('album','al-17e41d5b4f'); INSERT INTO album_display_group_members VALUES('al-17e41d5b4f');"
$late += ".read $rollback"
$late += "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads' AND track IS NULL AND disc IS NULL) AS restored,(SELECT COUNT(*) FROM song_masters WHERE id='external-master' AND album_id='al-17e41d5b4f') AS external_kept,(SELECT COUNT(*) FROM albums WHERE id='al-17e41d5b4f' AND cover_r2_key='covers/keep') AS album_kept,(SELECT COUNT(*) FROM annotations WHERE item_id='al-17e41d5b4f') AS annotation_kept,(SELECT COUNT(*) FROM album_display_group_members WHERE album_id='al-17e41d5b4f') AS display_kept;"
$lateOut = ($late -join "`n" | & $sqlite ':memory:' 2>&1) -join "`n"
if ($lateOut -notmatch '22\|1\|1\|1\|1') { throw "late rollback failed: $lateOut" }

[pscustomobject]@{ stale_guard='rejected atomically'; late_rollback='22 candidates restored; external member and references retained' } | ConvertTo-Json -Compress
