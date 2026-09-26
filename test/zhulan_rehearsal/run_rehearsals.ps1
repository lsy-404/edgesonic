$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$candidate = Join-Path $repo 'agents/531_[Audit]_pending_album_identity/apply_zhulan_collection.sql'
$fixture = Join-Path $PSScriptRoot 'fixture.sql'
$config = Join-Path $PSScriptRoot 'wrangler.toml'
$runtime = Join-Path $PSScriptRoot '.runtime'

function Invoke-LocalD1([string]$State, [string[]]$Operation, [switch]$ExpectFailure) {
  $cliArgs = @('wrangler', 'd1', 'execute', 'zhulan-rehearsal', '--local', '--config', $config, '--persist-to', (Join-Path $runtime $State)) + $Operation + @('--json')
  $output = & npx @cliArgs 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  if ($ExpectFailure) {
    if ($exitCode -eq 0) { throw "Expected local D1 failure for $State" }
    return $output
  }
  if ($exitCode -ne 0) { throw $output }
  return $output
}

function Read-JsonResults([string]$Output) {
  return ,(ConvertFrom-Json -InputObject $Output)
}

function Seed([string]$State) {
  Invoke-LocalD1 $State @('--file', $fixture) | Out-Null
}

Set-Location $repo
python (Join-Path $PSScriptRoot 'make_fixture.py')
if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed' }

Seed 'success'
Invoke-LocalD1 'success' @('--file', $candidate) | Out-Null
$success = Read-JsonResults (Invoke-LocalD1 'success' @('--command', "SELECT song_count,duration,size,(SELECT MIN(track) FROM song_masters WHERE album_id=albums.id) min_track,(SELECT MAX(track) FROM song_masters WHERE album_id=albums.id) max_track,(SELECT COUNT(DISTINCT track) FROM song_masters WHERE album_id=albums.id) unique_tracks FROM albums WHERE id='al-fe198b18b1'"))
$album = $success[0].results[0]
if ($album.song_count -ne 28 -or $album.min_track -ne 1 -or $album.max_track -ne 28 -or $album.unique_tracks -ne 28) { throw 'Success state did not produce tracks 1–28' }

Seed 'stale'
Invoke-LocalD1 'stale' @('--command', "UPDATE song_masters SET title=title || ' changed' WHERE id='sm-upload-1f9017ea-07f'") | Out-Null
Invoke-LocalD1 'stale' @('--file', $candidate) -ExpectFailure | Out-Null
$stale = Read-JsonResults (Invoke-LocalD1 'stale' @('--command', "SELECT (SELECT COUNT(*) FROM artists WHERE id='ar-abdf58605e') target_artist,(SELECT COUNT(*) FROM albums WHERE id='al-fe198b18b1') target_album,(SELECT COUNT(*) FROM song_masters WHERE id LIKE 'sm-upload-%' AND album_id='pending-uploads') pending_cohort"))
if ($stale[0].results[0].target_artist -ne 0 -or $stale[0].results[0].target_album -ne 0 -or $stale[0].results[0].pending_cohort -ne 28) { throw 'Stale-source guard changed the candidate cohort' }

Seed 'late'
Invoke-LocalD1 'late' @('--command', "INSERT INTO work_queue(id,task_type,payload,status,created_at) VALUES('zhulan-force-late-failure','metadata','{}','queued',unixepoch())") | Out-Null
Invoke-LocalD1 'late' @('--file', $candidate) -ExpectFailure | Out-Null
$late = Read-JsonResults (Invoke-LocalD1 'late' @('--command', "SELECT (SELECT COUNT(*) FROM artists WHERE id='ar-abdf58605e') target_artist,(SELECT COUNT(*) FROM albums WHERE id='al-fe198b18b1') target_album,(SELECT COUNT(*) FROM song_masters WHERE album_id='al-fe198b18b1') target_masters,(SELECT COUNT(*) FROM song_masters WHERE id LIKE 'sm-upload-%' AND album_id='pending-uploads') pending_cohort,(SELECT COUNT(*) FROM work_queue WHERE id='zhulan-force-late-failure') marker"))
$lateState = $late[0].results[0]
if ($lateState.target_artist -ne 0 -or $lateState.target_album -ne 0 -or $lateState.target_masters -ne 0 -or $lateState.pending_cohort -ne 28 -or $lateState.marker -ne 1) { throw 'Late failure did not roll back the candidate writes' }

Write-Output 'Wrangler local rehearsals passed: success, stale-source rejection, and atomic late rollback.'
