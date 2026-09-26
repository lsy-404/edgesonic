$ErrorActionPreference='Stop'
$base=Split-Path -Parent $PSCommandPath
$scope=Get-Content -Raw -LiteralPath (Join-Path $base 'primary_scope.json')|ConvertFrom-Json
$rows=@($scope[0].results)
if($rows.Count -ne 25){throw "expected 25 pending rows, got $($rows.Count)"}
$target='al-find-zero-wav'
$group='dg-find-zero-editions'
$existing='al-0494f8ac9c'
$values=($rows|ForEach-Object{
  $disc=if($_.disc_folder -eq 'CD 1 人声碟'){1}elseif($_.disc_folder -eq 'CD 2 伴奏碟'){2}else{throw "unexpected folder $($_.disc_folder)"}
  $track=[int]([regex]::Match($_.display_name,'^(\d{2})').Groups[1].Value)
  if($track -lt 1){throw "missing track number: $($_.display_name)"}
  "('$($_.master_id)','$($_.instance_id)','$($_.object_id)','$($_.entry_id)',$disc,$track,'$($_.title.Replace("'","''"))','$($_.path.Replace("'","''"))')"
}) -join ",`n"
$apply=@"
BEGIN IMMEDIATE;
CREATE TEMP TABLE candidate(master_id TEXT,instance_id TEXT,object_id TEXT,entry_id TEXT,disc INTEGER,track INTEGER,title TEXT,path TEXT);
INSERT INTO candidate VALUES
$values;
CREATE TEMP TABLE assertion(value INTEGER NOT NULL CHECK(value=1));
INSERT INTO assertion SELECT CASE WHEN
 (SELECT COUNT(*) FROM candidate)=25 AND
 (SELECT COUNT(*) FROM song_masters sm JOIN candidate c ON c.master_id=sm.id WHERE sm.album_id='pending-uploads' AND sm.track IS NULL AND sm.disc IS NULL AND sm.title=c.title)=25 AND
 (SELECT COUNT(*) FROM song_instances si JOIN candidate c ON c.instance_id=si.id WHERE si.master_id=c.master_id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id)=25 AND
 (SELECT COUNT(*) FROM storage_objects so JOIN candidate c ON c.object_id=so.id WHERE so.physical_key='objects/'||c.object_id||'.wav')=25 AND
 (SELECT COUNT(*) FROM storage_entries se JOIN candidate c ON c.entry_id=se.id WHERE se.kind='file' AND se.instance_id=c.instance_id AND se.object_id=c.object_id AND se.path=c.path)=25 AND
 NOT EXISTS(SELECT 1 FROM albums WHERE id='$target') AND
 EXISTS(SELECT 1 FROM albums WHERE id='$existing' AND name='Find-Zero' AND song_count=14) AND
 NOT EXISTS(SELECT 1 FROM album_display_group_members WHERE album_id IN ('$existing','$target')) AND
 NOT EXISTS(SELECT 1 FROM candidate c JOIN playlist_songs p ON p.song_master_id=c.master_id) AND
 NOT EXISTS(SELECT 1 FROM candidate c JOIN annotations a ON a.item_type='song' AND a.item_id=c.master_id)
 THEN 1 ELSE 0 END;
INSERT INTO albums(id,name,sort_name,genre,compilation,song_count,duration,size) VALUES('$target','Find-Zero','find-zero','未知流派',0,0,0,0);
INSERT INTO album_display_groups(id,display_name,sort_name) VALUES('$group','Find-Zero','find-zero');
INSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES('$group','$existing',0),('$group','$target',1);
UPDATE song_masters SET album_id='$target',disc=(SELECT disc FROM candidate WHERE master_id=song_masters.id),track=(SELECT track FROM candidate WHERE master_id=song_masters.id),updated_at=unixepoch() WHERE id IN(SELECT master_id FROM candidate) AND album_id='pending-uploads' AND track IS NULL AND disc IS NULL;
INSERT INTO assertion SELECT CASE WHEN (SELECT COUNT(*) FROM song_masters WHERE album_id='$target')=25 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='$target' AND (disc NOT IN(1,2) OR track IS NULL))=0 THEN 1 ELSE 0 END;
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN('pending-uploads','$target');
COMMIT;
"@
$rollback=@"
BEGIN IMMEDIATE;
CREATE TEMP TABLE candidate(master_id TEXT,instance_id TEXT,object_id TEXT,entry_id TEXT,disc INTEGER,track INTEGER,title TEXT,path TEXT);
INSERT INTO candidate VALUES
$values;
CREATE TEMP TABLE assertion(value INTEGER NOT NULL CHECK(value=1));
INSERT INTO assertion SELECT CASE WHEN
 (SELECT COUNT(*) FROM song_masters sm JOIN candidate c ON c.master_id=sm.id WHERE sm.album_id='$target' AND sm.disc=c.disc AND sm.track=c.track AND sm.title=c.title)=25 AND
 (SELECT COUNT(*) FROM song_masters WHERE album_id='$target')=25 AND
 (SELECT COUNT(*) FROM song_instances si JOIN candidate c ON c.instance_id=si.id WHERE si.master_id=c.master_id AND si.storage_object_id=c.object_id)=25 AND
 (SELECT COUNT(*) FROM storage_entries se JOIN candidate c ON c.entry_id=se.id WHERE se.instance_id=c.instance_id AND se.object_id=c.object_id AND se.path=c.path)=25 AND
 EXISTS(SELECT 1 FROM album_display_group_members WHERE group_id='$group' AND album_id='$existing') AND
 EXISTS(SELECT 1 FROM album_display_group_members WHERE group_id='$group' AND album_id='$target') AND
 NOT EXISTS(SELECT 1 FROM candidate c JOIN playlist_songs p ON p.song_master_id=c.master_id) AND
 NOT EXISTS(SELECT 1 FROM candidate c JOIN annotations a ON a.item_type='song' AND a.item_id=c.master_id)
 THEN 1 ELSE 0 END;
UPDATE song_masters SET album_id='pending-uploads',disc=NULL,track=NULL,updated_at=unixepoch() WHERE id IN(SELECT master_id FROM candidate) AND album_id='$target';
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id='pending-uploads';
DELETE FROM album_display_groups WHERE id='$group';
DELETE FROM albums WHERE id='$target' AND NOT EXISTS(SELECT 1 FROM song_masters WHERE album_id='$target');
COMMIT;
"@
Set-Content -LiteralPath (Join-Path $base 'apply.sql') -Value $apply -Encoding utf8
Set-Content -LiteralPath (Join-Path $base 'rollback.sql') -Value $rollback -Encoding utf8
$preflight=@"
WITH candidate(master_id,instance_id,object_id,entry_id,disc,track,title,path) AS (VALUES
$values
)
SELECT
 (SELECT COUNT(*) FROM candidate) AS candidate_count,
 (SELECT COUNT(*) FROM song_masters sm JOIN candidate c ON c.master_id=sm.id WHERE sm.album_id='pending-uploads' AND sm.track IS NULL AND sm.disc IS NULL AND sm.title=c.title) AS matching_pending_masters,
 (SELECT COUNT(*) FROM song_instances si JOIN candidate c ON c.instance_id=si.id WHERE si.master_id=c.master_id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id) AS matching_instances,
 (SELECT COUNT(*) FROM storage_objects so JOIN candidate c ON c.object_id=so.id WHERE so.physical_key='objects/'||c.object_id||'.wav') AS matching_objects,
 (SELECT COUNT(*) FROM storage_entries se JOIN candidate c ON c.entry_id=se.id WHERE se.kind='file' AND se.instance_id=c.instance_id AND se.object_id=c.object_id AND se.path=c.path) AS matching_entries,
 (SELECT COUNT(*) FROM albums WHERE id='$target') AS target_album_exists,
 (SELECT COUNT(*) FROM albums WHERE id='$existing' AND name='Find-Zero' AND song_count=14) AS existing_album_matches,
 (SELECT COUNT(*) FROM album_display_group_members WHERE album_id IN ('$existing','$target')) AS display_memberships,
 (SELECT COUNT(*) FROM playlist_songs ps JOIN candidate c ON c.master_id=ps.song_master_id) AS playlist_refs,
 (SELECT COUNT(*) FROM annotations a JOIN candidate c ON a.item_type='song' AND a.item_id=c.master_id) AS annotation_refs;
"@
Set-Content -LiteralPath (Join-Path $base 'preflight.sql') -Value $preflight -Encoding utf8
"apply and rollback generated for $($rows.Count) exact candidates" | Set-Content -LiteralPath (Join-Path $base 'operation_manifest.txt') -Encoding utf8
