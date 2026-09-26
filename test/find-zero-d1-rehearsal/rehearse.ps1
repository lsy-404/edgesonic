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
Invoke-D1 $success @('--file',(Join-Path $task 'apply.sql')) | Out-Null
$row=Invoke-Query $success "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav') tracks,(SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav' AND disc=1) disc1,(SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav' AND disc=2) disc2,(SELECT year FROM albums WHERE id='al-find-zero-wav') year,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='dg-find-zero-editions') members;"
Assert-Equal $row.tracks 25 'tracks'; Assert-Equal $row.disc1 14 'disc 1 tracks'; Assert-Equal $row.disc2 11 'disc 2 tracks'; Assert-Equal $row.year 2022 'year'; Assert-Equal $row.members 2 'display group members'
Invoke-D1 $success @('--file',(Join-Path $task 'rollback.sql')) | Out-Null
$row=Invoke-Query $success "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads' AND track IS NULL AND disc IS NULL) pending,(SELECT COUNT(*) FROM albums WHERE id='al-find-zero-wav') target;"
Assert-Equal $row.pending 25 'rollback pending tracks'; Assert-Equal $row.target 0 'rollback target album'
$stale=Join-Path $state 'stale'
Invoke-D1 $stale @('--file',(Join-Path $task 'fixture_stale.sql')) | Out-Null
Invoke-D1 $stale @('--file',(Join-Path $task 'apply.sql')) $true | Out-Null
$row=Invoke-Query $stale "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending,(SELECT COUNT(*) FROM albums WHERE id='al-find-zero-wav') target;"
Assert-Equal $row.pending 25 'stale pending tracks'; Assert-Equal $row.target 0 'stale target album'
$late=Join-Path $state 'late'
Invoke-D1 $late @('--file',(Join-Path $task 'fixture.sql')) | Out-Null
Invoke-D1 $late @('--file',(Join-Path $task 'apply.sql')) | Out-Null
Invoke-D1 $late @('--file',(Join-Path $task 'late_reference.sql')) | Out-Null
Invoke-D1 $late @('--file',(Join-Path $task 'rollback.sql')) $true | Out-Null
$row=Invoke-Query $late "SELECT (SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav') tracks,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='dg-find-zero-editions') members,(SELECT COUNT(*) FROM annotations WHERE item_type='song') refs;"
Assert-Equal $row.tracks 25 'late rollback tracks'; Assert-Equal $row.members 2 'late rollback memberships'; Assert-Equal $row.refs 1 'late annotation refs'
'Wrangler local D1 apply, rollback, stale-state rejection, and late-reference rejection passed.'
