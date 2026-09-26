$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$config = Join-Path $PSScriptRoot 'wrangler.toml'
$schema = Join-Path $PSScriptRoot 'schema.sql'
$seed = Join-Path $PSScriptRoot 'seed.sql'
$candidate = Join-Path $root 'agents/532_[Audit]_pending_radio_album_identity/prepare_q5_wav_alternate.sql'
$runtime = Join-Path $PSScriptRoot '.runtime'
if (Test-Path -LiteralPath $runtime) {
  $runtimePath = (Resolve-Path -LiteralPath $runtime).Path
  if (-not $runtimePath.StartsWith($PSScriptRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Local D1 state path escaped the rehearsal directory' }
  Remove-Item -LiteralPath $runtimePath -Recurse -Force
}
function Invoke-D1([string]$state,[string[]]$operation,[switch]$failure) {
  $persist = Join-Path $runtime $state
  $outputLines = & npx wrangler d1 execute q5-wav-alternate-rehearsal --local --config $config --persist-to $persist @operation --json 2>&1
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
 'albums',(SELECT json_group_array(json_array(id,name,song_count,duration,size)) FROM (SELECT id,name,song_count,duration,size FROM albums ORDER BY id)),
 'masters',(SELECT json_group_array(json_array(id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key)) FROM (SELECT id,album_id,artist_id,album_artist_id,title,track,disc,duration,lyrics,lyrics_rich,cover_r2_key FROM song_masters ORDER BY id)),
 'instances',(SELECT json_group_array(json_array(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag)) FROM (SELECT id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag FROM song_instances ORDER BY id)),
 'entries',(SELECT json_group_array(json_array(id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of)) FROM (SELECT id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of FROM storage_entries ORDER BY id)),
 'objects',(SELECT json_group_array(json_array(id,physical_key,suffix,content_type,size,legacy_key,etag)) FROM (SELECT id,physical_key,suffix,content_type,size,legacy_key,etag FROM storage_objects ORDER BY id)),
 'groups',(SELECT json_group_array(json_array(id,display_name,sort_name)) FROM (SELECT id,display_name,sort_name FROM album_display_groups ORDER BY id)),
 'members',(SELECT json_group_array(json_array(group_id,album_id,sort_order)) FROM (SELECT group_id,album_id,sort_order FROM album_display_group_members ORDER BY group_id,album_id)),
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
$success = Invoke-D1 'success' @('--command',"SELECT (SELECT song_count FROM albums WHERE id='al-q5-wav-alternate') alt_count,(SELECT duration FROM albums WHERE id='al-q5-wav-alternate') alt_duration,(SELECT size FROM albums WHERE id='al-q5-wav-alternate') alt_size,(SELECT year FROM albums WHERE id='al-q5-wav-alternate') alt_year,(SELECT cover_r2_key FROM albums WHERE id='al-q5-wav-alternate') alt_cover,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_size,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='ag-q5-edition-variants') members,(SELECT COUNT(*) FROM song_masters WHERE id='486' AND album_id='al-ac89e8964d' AND track=10 AND disc=1) original_intact,(SELECT COUNT(*) FROM song_masters WHERE id='sm-upload-1c5e734b-599' AND album_id='al-q5-wav-alternate' AND artist_id='ar-2b4aeae2d9' AND album_artist_id='ar-b86d3071fc' AND title='最后的歌' AND track=10 AND disc=1) canonical_metadata")
$row=(ConvertFrom-Json -InputObject $success)[0].results[0]
if($row.alt_count -ne 1 -or $row.alt_duration -ne 259 -or $row.alt_size -ne 45619436 -or $row.alt_year -ne 2016 -or $row.alt_cover -ne 'covers/al-ac89e8964d' -or $row.pending_count -ne 522 -or $row.pending_duration -ne 116545 -or $row.pending_size -ne 20262441225 -or $row.members -ne 2 -or $row.original_intact -ne 1 -or $row.canonical_metadata -ne 1){throw "Unexpected alternate-edition state: $success"}
Seed 'stale'
Invoke-D1 'stale' @('--command',"UPDATE storage_objects SET physical_key='objects/changed.wav' WHERE id='obj_790adcf9317cb20f'") | Out-Null
$beforeStale=Get-Fingerprint 'stale'
Invoke-D1 'stale' @('--file',$candidate) -failure | Out-Null
$afterStale=Get-Fingerprint 'stale'
if($beforeStale -ne $afterStale){throw 'Stale-source rejection changed the database fingerprint'}
Seed 'late'
Invoke-D1 'late' @('--command',"INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('q5-alternate-late-marker','metadata','{}','queued',unixepoch())") | Out-Null
$beforeLate=Get-Fingerprint 'late'
$lateFile=Join-Path $runtime 'forced-late-failure.sql'
$lateSql=(Get-Content -LiteralPath $candidate -Raw)+[Environment]::NewLine+"INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('q5-alternate-forced-failure','metadata','{}','guard_failed',unixepoch());"+[Environment]::NewLine
Set-Content -LiteralPath $lateFile -Value $lateSql -Encoding utf8
Invoke-D1 'late' @('--file',$lateFile) -failure | Out-Null
$afterLate=Get-Fingerprint 'late'
if($beforeLate -ne $afterLate){throw 'Late failure changed album, source, group, or queue state'}
Write-Output 'Wrangler local rehearsal passed: alternate edition success, stale physical-key rejection, and late-failure full-fingerprint rollback.'
