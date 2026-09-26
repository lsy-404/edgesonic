$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$config = Join-Path $PSScriptRoot 'wrangler.toml'
$schema = Join-Path $PSScriptRoot 'schema.sql'
$seed = Join-Path $PSScriptRoot 'seed.sql'
$anchorRepair = Join-Path $root 'agents/532_[Audit]_pending_radio_album_identity/prepare_ruler_a_anchor_disc.sql'
$bCandidate = Join-Path $root 'agents/532_[Audit]_pending_radio_album_identity/prepare_ruler_b_album_and_group.sql'
$runtime = Join-Path $PSScriptRoot '.runtime'
if (Test-Path -LiteralPath $runtime) {
  $runtimePath = (Resolve-Path -LiteralPath $runtime).Path
  if (-not $runtimePath.StartsWith($PSScriptRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Local D1 state path escaped the rehearsal directory' }
  Remove-Item -LiteralPath $runtimePath -Recurse -Force
}

function Invoke-D1([string]$state,[string[]]$operation,[switch]$failure) {
  $persist = Join-Path $runtime $state
  $outputLines = & npx wrangler d1 execute pending-radio-a-rehearsal --local --config $config --persist-to $persist @operation --json 2>&1
  $code = $LASTEXITCODE
  $output = $outputLines -join [Environment]::NewLine
  if ($failure) { if ($code -eq 0) { throw "Expected D1 failure: $state" }; return $output }
  if ($code -ne 0) { throw $output }
  return $output
}

function Seed([string]$state) {
  Invoke-D1 $state @('--file',$schema) | Out-Null
  Invoke-D1 $state @('--file',$seed) | Out-Null
}

$fingerprintSql = @'
SELECT json_object(
 'albums',(SELECT json_group_array(json_array(id,name,song_count,duration,size)) FROM (SELECT id,name,song_count,duration,size FROM albums WHERE id IN('pending-uploads','al-86f72c214f','al-ruler-mirror-b-edition') ORDER BY id)),
 'masters',(SELECT json_group_array(json_array(id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key)) FROM (SELECT id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key FROM song_masters WHERE album_id IN('pending-uploads','al-86f72c214f','al-ruler-mirror-b-edition') ORDER BY id)),
 'instances',(SELECT json_group_array(json_array(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag)) FROM (SELECT si.id,si.master_id,si.source_id,si.source_type,si.storage_uri,si.suffix,si.size,si.duration,si.missing,si.tag_scanned,si.storage_object_id,si.source_etag FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN('pending-uploads','al-86f72c214f','al-ruler-mirror-b-edition') ORDER BY si.id)),
 'entries',(SELECT json_group_array(json_array(id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of)) FROM (SELECT se.id,se.source_id,se.parent_id,se.path,se.display_name,se.kind,se.object_id,se.instance_id,se.companion_of FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN('pending-uploads','al-86f72c214f','al-ruler-mirror-b-edition') ORDER BY se.id)),
 'objects',(SELECT json_group_array(json_array(id,physical_key,suffix,size,legacy_key,etag)) FROM (SELECT so.id,so.physical_key,so.suffix,so.size,so.legacy_key,so.etag FROM storage_objects so JOIN song_instances si ON si.storage_object_id=so.id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN('pending-uploads','al-86f72c214f','al-ruler-mirror-b-edition') ORDER BY so.id)),
 'groups',(SELECT json_group_array(json_array(id,display_name,sort_name)) FROM (SELECT id,display_name,sort_name FROM album_display_groups ORDER BY id)),
 'group_members',(SELECT json_group_array(json_array(group_id,album_id,sort_order)) FROM (SELECT group_id,album_id,sort_order FROM album_display_group_members ORDER BY group_id,album_id)),
 'queue',(SELECT json_group_array(json_array(id,task_type,payload,status)) FROM (SELECT id,task_type,payload,status FROM work_queue ORDER BY id))
) fingerprint
'@

function Get-Fingerprint([string]$state) {
  $raw = Invoke-D1 $state @('--command',($fingerprintSql -replace '\s+',' '))
  return (ConvertFrom-Json -InputObject $raw)[0].results[0].fingerprint
}

Set-Location $root
Seed 'success'
Invoke-D1 'success' @('--file',$anchorRepair) | Out-Null
$anchorDiscs = Invoke-D1 'success' @('--command',"SELECT COUNT(*) n FROM song_masters WHERE id IN('sm-5e95a72c01','sm-c1be4c1e30') AND disc=1")
if ((ConvertFrom-Json -InputObject $anchorDiscs)[0].results[0].n -ne 2) { throw 'Anchor disc correction did not update both existing tracks' }
Invoke-D1 'success' @('--file',$bCandidate) | Out-Null
$bSuccess = Invoke-D1 'success' @('--command',"SELECT (SELECT song_count FROM albums WHERE id='al-ruler-mirror-b-edition') b_count,(SELECT duration FROM albums WHERE id='al-ruler-mirror-b-edition') b_duration,(SELECT size FROM albums WHERE id='al-ruler-mirror-b-edition') b_size,(SELECT COUNT(DISTINCT track) FROM song_masters WHERE album_id='al-ruler-mirror-b-edition' AND track BETWEEN 1 AND 16 AND disc=1) b_tracks,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_size,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='ag-ruler-mirror-editions') group_members")
$bRow = (ConvertFrom-Json -InputObject $bSuccess)[0].results[0]
if ($bRow.b_count -ne 16 -or $bRow.b_duration -ne 3230 -or $bRow.b_size -ne 569772704 -or $bRow.b_tracks -ne 16 -or $bRow.pending_count -ne 523 -or $bRow.pending_duration -ne 116804 -or $bRow.pending_size -ne 20308060661 -or $bRow.group_members -ne 2) { throw "Unexpected B-edition/group state: $bSuccess" }

Seed 'stale'
Invoke-D1 'stale' @('--file',$anchorRepair) | Out-Null
Invoke-D1 'stale' @('--command',"UPDATE storage_objects SET physical_key='objects/changed.wav' WHERE id='obj_4d00753c5c53a7b6'") | Out-Null
$beforeStale = Get-Fingerprint 'stale'
Invoke-D1 'stale' @('--file',$bCandidate) -failure | Out-Null
$afterStale = Get-Fingerprint 'stale'
if ($beforeStale -ne $afterStale) { throw 'Stale-source rejection changed the database fingerprint' }
$stale = Invoke-D1 'stale' @('--command',"SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-ruler-mirror-b-edition') b_rows,(SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending_rows,(SELECT COUNT(*) FROM work_queue) queue_rows")
$staleRow = (ConvertFrom-Json -InputObject $stale)[0].results[0]
if ($staleRow.b_rows -ne 0 -or $staleRow.pending_rows -ne 539 -or $staleRow.queue_rows -ne 0) { throw "Stale state changed: $stale" }

Seed 'late'
Invoke-D1 'late' @('--file',$anchorRepair) | Out-Null
Invoke-D1 'late' @('--command',"INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('radio-a-force-late-failure','metadata','{}','queued',unixepoch())") | Out-Null
$beforeLate = Get-Fingerprint 'late'
$lateFile = Join-Path $runtime 'forced-late-failure.sql'
$lateSql = (Get-Content -LiteralPath $bCandidate -Raw) + "`nINSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('radio-b-forced-late-failure','metadata','{}','guard_failed',unixepoch());`n"
Set-Content -LiteralPath $lateFile -Value $lateSql -Encoding utf8
Invoke-D1 'late' @('--file',$lateFile) -failure | Out-Null
$afterLate = Get-Fingerprint 'late'
if ($beforeLate -ne $afterLate) { throw 'Late-failure changed the albums, masters, source references, or queue fingerprint' }

Write-Output 'Wrangler local rehearsal passed: anchor-disc repair, B archive/display group, stale-source rejection, and late-failure rollback.'
