$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$config = Join-Path $PSScriptRoot 'wrangler.toml'
$schema = Join-Path $PSScriptRoot 'schema.sql'
$seed = Join-Path $PSScriptRoot 'seed.sql'
$candidate = Join-Path $root 'agents/532_[Audit]_pending_radio_album_identity/apply_ruler_a_album.sql'
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
 'albums',(SELECT json_group_array(json_array(id,name,song_count,duration,size)) FROM (SELECT id,name,song_count,duration,size FROM albums WHERE id IN('pending-uploads','al-86f72c214f') ORDER BY id)),
 'masters',(SELECT json_group_array(json_array(id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key)) FROM (SELECT id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key FROM song_masters WHERE album_id IN('pending-uploads','al-86f72c214f') ORDER BY id)),
 'instances',(SELECT json_group_array(json_array(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag)) FROM (SELECT si.id,si.master_id,si.source_id,si.source_type,si.storage_uri,si.suffix,si.size,si.duration,si.missing,si.tag_scanned,si.storage_object_id,si.source_etag FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN('pending-uploads','al-86f72c214f') ORDER BY si.id)),
 'entries',(SELECT json_group_array(json_array(id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of)) FROM (SELECT se.id,se.source_id,se.parent_id,se.path,se.display_name,se.kind,se.object_id,se.instance_id,se.companion_of FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN('pending-uploads','al-86f72c214f') ORDER BY se.id)),
 'objects',(SELECT json_group_array(json_array(id,physical_key,suffix,size,legacy_key,etag)) FROM (SELECT so.id,so.physical_key,so.suffix,so.size,so.legacy_key,so.etag FROM storage_objects so JOIN song_instances si ON si.storage_object_id=so.id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN('pending-uploads','al-86f72c214f') ORDER BY so.id)),
 'queue',(SELECT json_group_array(json_array(id,task_type,payload,status)) FROM (SELECT id,task_type,payload,status FROM work_queue ORDER BY id))
) fingerprint
'@

function Get-Fingerprint([string]$state) {
  $raw = Invoke-D1 $state @('--command',($fingerprintSql -replace '\s+',' '))
  return (ConvertFrom-Json -InputObject $raw)[0].results[0].fingerprint
}

Set-Location $root
Seed 'success'
Invoke-D1 'success' @('--file',$candidate) | Out-Null
$success = Invoke-D1 'success' @('--command',"SELECT (SELECT song_count FROM albums WHERE id='al-86f72c214f') target_count,(SELECT duration FROM albums WHERE id='al-86f72c214f') target_duration,(SELECT size FROM albums WHERE id='al-86f72c214f') target_size,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_size,(SELECT COUNT(DISTINCT track) FROM song_masters WHERE album_id='al-86f72c214f' AND track BETWEEN 1 AND 8) unique_tracks")
$successRow = (ConvertFrom-Json -InputObject $success)[0].results[0]
if ($successRow.target_count -ne 8 -or $successRow.target_duration -ne 1540 -or $successRow.target_size -ne 271656352 -or $successRow.pending_count -ne 575 -or $successRow.pending_duration -ne 128561 -or $successRow.pending_size -ne 22410550173 -or $successRow.unique_tracks -ne 8) { throw "Unexpected success state: $success" }

Seed 'stale'
Invoke-D1 'stale' @('--command',"UPDATE storage_objects SET physical_key='objects/changed.wav' WHERE id='obj_10b259d1d3a7dea8'") | Out-Null
Invoke-D1 'stale' @('--file',$candidate) -failure | Out-Null
$stale = Invoke-D1 'stale' @('--command',"SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-86f72c214f') target_rows,(SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending_rows,(SELECT COUNT(*) FROM work_queue) queue_rows")
$staleRow = (ConvertFrom-Json -InputObject $stale)[0].results[0]
if ($staleRow.target_rows -ne 2 -or $staleRow.pending_rows -ne 581 -or $staleRow.queue_rows -ne 0) { throw "Stale state changed: $stale" }

Seed 'late'
Invoke-D1 'late' @('--command',"INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('radio-a-force-late-failure','metadata','{}','queued',unixepoch())") | Out-Null
$beforeLate = Get-Fingerprint 'late'
Invoke-D1 'late' @('--file',$candidate) -failure | Out-Null
$afterLate = Get-Fingerprint 'late'
if ($beforeLate -ne $afterLate) { throw 'Late-failure changed the albums, masters, source references, or queue fingerprint' }

Write-Output 'Wrangler local rehearsal passed: success, stale physical-key rejection, and late-failure rollback.'
