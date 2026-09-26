$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$task=Join-Path $repo 'agents/523_[Operations]_find_zero_disc_backfill'
$config=Join-Path $PSScriptRoot 'wrangler.toml'
$database='find-zero-local-fixture'
$state=Join-Path $env:TEMP ('find-zero-d1-rehearsal-'+[guid]::NewGuid().ToString('N'))
$worker=Join-Path $repo 'worker'
function Invoke-D1([string]$persist,[string[]]$sqlArgs,[bool]$expectFailure=$false){
  Push-Location $worker
  try{
    $output=& npx.cmd wrangler d1 execute $database --local --config $config --persist-to $persist @sqlArgs --json 2>&1 | Out-String
    $code=$LASTEXITCODE
  }finally{Pop-Location}
  if($expectFailure){if($code -eq 0){throw 'Expected guarded SQL to fail.'};return $output}
  if($code -ne 0){throw "Wrangler D1 failed with exit code $code.`n$output"}
  return $output
}
function Invoke-Query([string]$persist,[string]$sql){
  $raw=Invoke-D1 $persist @('--command',$sql)
  return (@($raw | ConvertFrom-Json)[0].results[0])
}
function Assert-Equal($actual,$expected,[string]$name){if($actual -ne $expected){throw "$name expected $expected; got $actual"}}
& (Join-Path $task 'make_local_fixture.ps1')
$success=Join-Path $state 'success'
Invoke-D1 $success @('--file',(Join-Path $task 'fixture.sql')) | Out-Null
$row=Invoke-Query $success "SELECT (SELECT duration FROM albums WHERE id='al-0494f8ac9c') cached_duration,(SELECT size FROM albums WHERE id='al-0494f8ac9c') cached_size,(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id='al-0494f8ac9c') master_duration,(SELECT COALESCE(SUM(si.duration),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-0494f8ac9c') instance_duration;"
Assert-Equal $row.cached_duration 0 'stale cached FLAC duration'; Assert-Equal $row.cached_size 411082170 'FLAC size'; Assert-Equal $row.master_duration 3173 'FLAC master duration'; Assert-Equal $row.instance_duration 3173 'FLAC instance duration'
Invoke-D1 $success @('--file',(Join-Path $task 'apply.sql')) | Out-Null
$row=Invoke-Query $success "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav') tracks,(SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav' AND disc=1) disc1,(SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav' AND disc=2) disc2,(SELECT year IS NULL FROM albums WHERE id='al-find-zero-wav') year_is_null,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='dg-find-zero-editions') members,(SELECT song_count FROM albums WHERE id='al-0494f8ac9c') flac_count,(SELECT duration FROM albums WHERE id='al-0494f8ac9c') flac_duration,(SELECT size FROM albums WHERE id='al-0494f8ac9c') flac_size,(SELECT duration FROM albums WHERE id='al-find-zero-wav') wav_duration,(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id='al-find-zero-wav') wav_sum_duration,(SELECT size FROM albums WHERE id='al-find-zero-wav') wav_size,(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id='al-find-zero-wav') wav_sum_size,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_duration,(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id='pending-uploads') pending_sum_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_size,(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id='pending-uploads') pending_sum_size;"
Assert-Equal $row.tracks 25 'tracks'; Assert-Equal $row.disc1 14 'disc 1 tracks'; Assert-Equal $row.disc2 11 'disc 2 tracks'; Assert-Equal $row.year_is_null 1 'unset year'; Assert-Equal $row.members 2 'display group members'; Assert-Equal $row.flac_count 14 'FLAC track count'; Assert-Equal $row.flac_duration 3173 'FLAC recalculated duration'; Assert-Equal $row.flac_size 411082170 'FLAC size'; Assert-Equal $row.wav_duration $row.wav_sum_duration 'WAV duration aggregate'; Assert-Equal $row.wav_size $row.wav_sum_size 'WAV size aggregate'; Assert-Equal $row.pending_count 0 'pending count'; Assert-Equal $row.pending_duration $row.pending_sum_duration 'pending duration aggregate'; Assert-Equal $row.pending_size $row.pending_sum_size 'pending size aggregate'
Invoke-D1 $success @('--file',(Join-Path $task 'rollback.sql')) | Out-Null
$row=Invoke-Query $success "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads' AND track IS NULL AND disc IS NULL) pending,(SELECT COUNT(*) FROM albums WHERE id='al-find-zero-wav') target,(SELECT duration FROM albums WHERE id='al-0494f8ac9c') flac_duration;"
Assert-Equal $row.pending 25 'rollback pending tracks'; Assert-Equal $row.target 0 'rollback target album'; Assert-Equal $row.flac_duration 3173 'FLAC corrected duration persists'
$stale=Join-Path $state 'stale'
Invoke-D1 $stale @('--file',(Join-Path $task 'fixture_stale.sql')) | Out-Null
Invoke-D1 $stale @('--file',(Join-Path $task 'apply.sql')) $true | Out-Null
$row=Invoke-Query $stale "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending,(SELECT COUNT(*) FROM albums WHERE id='al-find-zero-wav') target,(SELECT duration FROM albums WHERE id='al-0494f8ac9c') flac_duration;"
Assert-Equal $row.pending 25 'stale pending tracks'; Assert-Equal $row.target 0 'stale target album'; Assert-Equal $row.flac_duration 0 'stale guard leaves FLAC cache unchanged'
$late=Join-Path $state 'late'
Invoke-D1 $late @('--file',(Join-Path $task 'fixture.sql')) | Out-Null
Invoke-D1 $late @('--file',(Join-Path $task 'apply.sql')) | Out-Null
Invoke-D1 $late @('--file',(Join-Path $task 'late_reference.sql')) | Out-Null
Invoke-D1 $late @('--file',(Join-Path $task 'rollback.sql')) $true | Out-Null
$row=Invoke-Query $late "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav') tracks,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='dg-find-zero-editions') members,(SELECT COUNT(*) FROM annotations WHERE item_type='song') refs,(SELECT duration FROM albums WHERE id='al-0494f8ac9c') flac_duration;"
Assert-Equal $row.tracks 25 'late rollback tracks'; Assert-Equal $row.members 2 'late rollback memberships'; Assert-Equal $row.refs 1 'late annotation refs'; Assert-Equal $row.flac_duration 3173 'late rollback FLAC duration'
'Wrangler local D1 apply, rollback, stale-state rejection, and late-reference rejection passed.'
