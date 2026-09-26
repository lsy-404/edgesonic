$ErrorActionPreference='Stop'
$base=Split-Path -Parent $PSCommandPath
$scope=Get-Content -Raw -LiteralPath (Join-Path $base 'primary_scope.json')|ConvertFrom-Json
$rows=@($scope[0].results)
if($rows.Count -ne 25){throw "expected 25 pending rows, got $($rows.Count)"}
$q={param([string]$v) "'"+$v.Replace("'","''")+"'"}
$target='al-find-zero-wav'
$group='dg-find-zero-editions'
$existing='al-0494f8ac9c'
$vals=[System.Collections.Generic.List[string]]::new()
foreach($r in $rows){
  $disc=if($r.disc_folder -eq 'CD 1 人声碟'){1}elseif($r.disc_folder -eq 'CD 2 伴奏碟'){2}else{throw "unexpected folder $($r.disc_folder)"}
  $track=[int]([regex]::Match([string]$r.display_name,'^(\d{2})').Groups[1].Value)
  if($track -lt 1){throw "missing source track number: $($r.display_name)"}
  $fields=@($r.master_id,$r.instance_id,$r.object_id,$r.entry_id,$r.parent_id,$r.path,$r.physical_key,$r.title)|ForEach-Object{& $q ([string]$_)}
  $vals.Add("("+($fields -join ',')+",$disc,$track)")
}
$values=$vals -join ",`n"
$columns='master_id,instance_id,object_id,entry_id,parent_id,path,physical_key,title_snapshot,disc,track'
$exact=@"
(SELECT COUNT(*) FROM c)=25 AND
(SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='pending-uploads' AND sm.title IS c.title_snapshot AND sm.track IS NULL AND sm.disc IS NULL JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id JOIN storage_objects so ON so.id=c.object_id AND so.physical_key IS c.physical_key JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id AND se.object_id=so.id AND se.parent_id IS c.parent_id AND se.path IS c.path AND se.kind='file')=25 AND
(SELECT COUNT(*) FROM c JOIN storage_entries se ON se.id=c.entry_id WHERE EXISTS(SELECT 1 FROM storage_entries child WHERE child.parent_id=se.id))=0 AND
NOT EXISTS(SELECT 1 FROM c JOIN playlist_songs p ON p.song_master_id=c.master_id) AND
NOT EXISTS(SELECT 1 FROM c JOIN annotations a ON a.item_type='song' AND a.item_id=c.master_id) AND
NOT EXISTS(SELECT 1 FROM c JOIN song_artists sa ON sa.song_id=c.master_id)
"@
$apply=@"
WITH c($columns) AS (VALUES
$values
)
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav','metadata','{}','guard_failed',unixepoch()
WHERE NOT ($exact
AND NOT EXISTS(SELECT 1 FROM albums WHERE id='$target')
AND NOT EXISTS(SELECT 1 FROM album_display_groups WHERE id='$group')
AND EXISTS(SELECT 1 FROM albums WHERE id='$existing' AND name='Find-Zero' AND song_count=14)
AND NOT EXISTS(SELECT 1 FROM album_display_group_members WHERE album_id IN ('$existing','$target')));
INSERT INTO albums(id,name,sort_name,year,genre,compilation,song_count,duration,size,created_at,updated_at) VALUES('$target','Find-Zero (WAV)','find-zero-wav',NULL,'未知流派',0,0,0,0,unixepoch(),unixepoch());
WITH c($columns) AS (VALUES
$values
)
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=1;
INSERT INTO album_display_groups(id,display_name,sort_name) VALUES('$group','Find-Zero','find-zero');
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=1;
INSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES('$group','$existing',0),('$group','$target',1);
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=2;
WITH c($columns) AS (VALUES
$values
)
UPDATE song_masters SET album_id='$target',disc=(SELECT c.disc FROM c WHERE c.master_id=song_masters.id),track=(SELECT c.track FROM c WHERE c.master_id=song_masters.id),updated_at=unixepoch()
WHERE id IN(SELECT master_id FROM c) AND album_id='pending-uploads' AND track IS NULL AND disc IS NULL;
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=25;
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN('pending-uploads','$target');
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav','metadata','{}','guard_failed',unixepoch()
WHERE (SELECT COUNT(*) FROM song_masters WHERE album_id='$target')!=25 OR (SELECT COUNT(*) FROM song_masters WHERE album_id='$target' AND disc=1)!=14 OR (SELECT COUNT(*) FROM song_masters WHERE album_id='$target' AND disc=2)!=11;
"@
$rollback=@"
WITH c($columns) AS (VALUES
$values
)
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav-rollback','metadata','{}','guard_failed',unixepoch()
WHERE NOT ((SELECT COUNT(*) FROM c)=25
AND (SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='$target' AND sm.title IS c.title_snapshot AND sm.disc=c.disc AND sm.track=c.track JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id JOIN storage_objects so ON so.id=c.object_id AND so.physical_key IS c.physical_key JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id AND se.object_id=so.id AND se.parent_id IS c.parent_id AND se.path IS c.path AND se.kind='file')=25
AND (SELECT COUNT(*) FROM song_masters WHERE album_id='$target')=25
AND (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='$group')=2
AND EXISTS(SELECT 1 FROM album_display_group_members WHERE group_id='$group' AND album_id='$existing' AND sort_order=0)
AND EXISTS(SELECT 1 FROM album_display_group_members WHERE group_id='$group' AND album_id='$target' AND sort_order=1)
AND NOT EXISTS(SELECT 1 FROM c JOIN playlist_songs p ON p.song_master_id=c.master_id)
AND NOT EXISTS(SELECT 1 FROM c JOIN annotations a ON a.item_type='song' AND a.item_id=c.master_id)
AND NOT EXISTS(SELECT 1 FROM c JOIN song_artists sa ON sa.song_id=c.master_id) AND NOT EXISTS(SELECT 1 FROM annotations WHERE item_type='album' AND item_id='') AND NOT EXISTS(SELECT 1 FROM album_display_group_members WHERE album_id='' AND group_id!='') AND NOT EXISTS(SELECT 1 FROM c JOIN storage_entries se ON se.id=c.entry_id JOIN storage_entries child ON child.parent_id=se.id));
WITH c($columns) AS (VALUES
$values
)
UPDATE song_masters SET album_id='pending-uploads',disc=NULL,track=NULL,updated_at=unixepoch()
WHERE id IN(SELECT master_id FROM c) AND album_id='$target';
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav-rollback','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=25;
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id='pending-uploads';
DELETE FROM album_display_group_members WHERE group_id='$group' AND album_id IN('$existing','$target');
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav-rollback','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=2;
DELETE FROM album_display_groups WHERE id='$group';
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav-rollback','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=1;
DELETE FROM albums WHERE id='$target' AND NOT EXISTS(SELECT 1 FROM song_masters WHERE album_id='$target');
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'guard-find-zero-wav-rollback','metadata','{}','guard_failed',unixepoch()
WHERE changes()!=1;
"@
$preflight=@"
WITH c($columns) AS (VALUES
$values
)
SELECT (SELECT COUNT(*) FROM c) AS candidate_count,
(SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='pending-uploads' AND sm.title IS c.title_snapshot AND sm.track IS NULL AND sm.disc IS NULL JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id JOIN storage_objects so ON so.id=c.object_id AND so.physical_key IS c.physical_key JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id AND se.object_id=so.id AND se.parent_id IS c.parent_id AND se.path IS c.path AND se.kind='file') AS matching_exact_rows,
(SELECT COUNT(*) FROM song_masters WHERE album_id='$target') AS target_album_tracks,
(SELECT COUNT(*) FROM albums WHERE id='$target') AS target_album_exists,
(SELECT COUNT(*) FROM albums WHERE id='$existing' AND name='Find-Zero' AND song_count=14) AS existing_album_matches,
(SELECT COUNT(*) FROM album_display_groups WHERE id='$group') AS group_id_exists,
(SELECT COUNT(*) FROM album_display_group_members WHERE album_id IN('$existing','$target')) AS display_memberships,
(SELECT COUNT(*) FROM c JOIN playlist_songs p ON p.song_master_id=c.master_id) AS playlist_refs,
(SELECT COUNT(*) FROM c JOIN annotations a ON a.item_type='song' AND a.item_id=c.master_id) AS annotation_refs,
(SELECT COUNT(*) FROM c JOIN song_artists sa ON sa.song_id=c.master_id) AS song_artist_refs,
(SELECT COUNT(*) FROM c JOIN storage_entries se ON se.id=c.entry_id JOIN storage_entries child ON child.parent_id=se.id) AS child_entries;
"@
Set-Content -LiteralPath (Join-Path $base 'apply.sql') -Value $apply -Encoding utf8
Set-Content -LiteralPath (Join-Path $base 'rollback.sql') -Value $rollback -Encoding utf8
Set-Content -LiteralPath (Join-Path $base 'preflight.sql') -Value $preflight -Encoding utf8
'guarded apply/rollback and read-only preflight generated for 25 exact candidates' | Set-Content -LiteralPath (Join-Path $base 'operation_manifest.txt') -Encoding utf8
