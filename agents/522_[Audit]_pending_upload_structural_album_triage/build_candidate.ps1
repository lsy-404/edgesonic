$root = Split-Path -Parent $PSScriptRoot
$worker = 'F:\Development\lsy-404@edgesonic\worker'
$query = @"
SELECT sm.id AS master_id,sm.title,se.id AS entry_id,se.parent_id,se.path,si.id AS instance_id,si.storage_object_id,si.suffix,si.size,si.source_etag
FROM song_masters AS sm JOIN song_instances AS si ON si.master_id=sm.id JOIN storage_entries AS se ON se.instance_id=si.id AND se.kind='file'
WHERE sm.album_id='pending-uploads' AND se.parent_id IN ('se-4ebf55c2760f4094ac9b4834ea1ac2f6','se-675f777b8c4d4ea987bf9d1a3500f12a') ORDER BY se.parent_id,se.path;
"@
Push-Location $worker
try {
  $oneLine = ($query -replace "[\r\n]+", ' ').Trim()
  $raw = Invoke-Expression "npx wrangler d1 execute edgesonic-db --remote --command `"$oneLine`" --json 2>&1" | Out-String
}
finally { Pop-Location }
$jsonMatch = [regex]::Match($raw, '\[\s*\{\s*"results"')
if (-not $jsonMatch.Success) { throw "Wrangler returned no JSON: $raw" }
$raw = $raw.Substring($jsonMatch.Index)
$rows = (($raw | ConvertFrom-Json)[0].results)
if ($rows.Count -ne 22) { throw "expected 22 rows, got $($rows.Count)" }
function Q([string]$v) { "'" + $v.Replace("'", "''") + "'" }
$items = for ($i=0; $i -lt $rows.Count; $i++) { $r=$rows[$i]; $disc=if($r.parent_id -eq 'se-4ebf55c2760f4094ac9b4834ea1ac2f6'){1}else{2}; [pscustomobject]@{master_id=$r.master_id;entry_id=$r.entry_id;parent_id=$r.parent_id;path=$r.path;instance_id=$r.instance_id;object_id=$r.storage_object_id;title=$r.title;disc=$disc;track=if($disc -eq 1){$i+1}else{$i-11}} }
$vals=($items|ForEach-Object { $parts=@($_.master_id,$_.entry_id,$_.parent_id,$_.path,$_.instance_id,$_.object_id,$_.title,$_.disc,$_.track)|ForEach-Object {if($_ -is [int]){"$_"}else{Q $_}}; '('+($parts -join ',')+')' }) -join ",`n"
$cte="WITH c(master_id,entry_id,parent_id,path,instance_id,object_id,title_snapshot,disc,track) AS (VALUES`n$vals`n)"
$exact="(SELECT COUNT(*) FROM c JOIN song_masters sm ON sm.id=c.master_id AND sm.album_id='pending-uploads' AND sm.title IS c.title_snapshot AND sm.track IS NULL AND sm.disc IS NULL JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav' AND si.storage_object_id=c.object_id JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id AND se.parent_id=c.parent_id AND se.path=c.path AND se.object_id=si.storage_object_id AND se.kind='file')"
$ids=($items.master_id|ForEach-Object{Q $_}) -join ','
$apply=@("$cte`nINSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'pending-structural-guard','metadata','{}','guard_failed',unixepoch() WHERE NOT ($exact=22 AND NOT EXISTS(SELECT 1 FROM albums WHERE id='al-17e41d5b4f') AND (SELECT COUNT(*) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' WHERE se.path LIKE 'Distortion and Overdrive（2014）/%' AND si.missing=0)=22);","INSERT INTO albums(id,name,sort_name,year,created_at,updated_at) VALUES('al-17e41d5b4f','Distortion and Overdrive（2014）','distortion and overdrive（2014）',2014,unixepoch(),unixepoch());","INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'pending-structural-guard','metadata','{}','guard_failed',unixepoch() WHERE changes()!=1;","$cte UPDATE song_masters SET album_id='al-17e41d5b4f',disc=(SELECT disc FROM c WHERE c.master_id=song_masters.id),track=(SELECT track FROM c WHERE c.master_id=song_masters.id),updated_at=unixepoch() WHERE id IN(SELECT master_id FROM c) AND album_id='pending-uploads' AND track IS NULL AND disc IS NULL;","INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'pending-structural-guard','metadata','{}','guard_failed',unixepoch() WHERE changes()!=22;","UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(sm.duration),0) FROM song_masters sm WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN('pending-uploads','al-17e41d5b4f');") -join "`n"
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'apply_distortion_overdrive.sql') -Value $apply -Encoding utf8
$items | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'candidate_snapshot.json') -Encoding utf8
