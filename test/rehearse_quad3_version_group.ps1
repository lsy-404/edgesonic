$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $root 'worker'
$fixture = Join-Path $PSScriptRoot 'fixtures\quad3_version_group.sql'
$config = Join-Path $PSScriptRoot 'fixtures\quad3_wrangler.toml'
$candidate = Join-Path $root 'agents\527_[Operations]_quadimension_3_version_group\apply_guarded.sql'

function Invoke-D1File([string]$persist, [string]$file) {
  Push-Location $worker
  try { & npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --file $file --json | Out-Null; return $LASTEXITCODE }
  finally { Pop-Location }
}
function Invoke-D1Query([string]$persist, [string]$sql) {
  Push-Location $worker
  try { return & npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --command $sql --json }
  finally { Pop-Location }
}
function New-RunDirectory { Join-Path ([System.IO.Path]::GetTempPath()) ('edgesonic-q3-' + [guid]::NewGuid().ToString('N')) }

$success = New-RunDirectory
if ((Invoke-D1File $success $fixture) -ne 0) { throw 'fixture setup failed' }
if ((Invoke-D1File $success $candidate) -ne 0) { throw 'candidate failed on success fixture' }
$successRows = Invoke-D1Query $success "SELECT (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='ag-q3-flac-wav-20260926') AS members, (SELECT COUNT(*) FROM song_masters WHERE album_id='al-q3-wav-20260926') AS wav_tracks, (SELECT COUNT(*) FROM song_masters WHERE album_id='al-1a27548730') AS flac_tracks;"
$successText = $successRows | Out-String
if ($successText -notmatch '"members"\s*:\s*2' -or $successText -notmatch '"wav_tracks"\s*:\s*9' -or $successText -notmatch '"flac_tracks"\s*:\s*9') { throw 'success verification failed' }

$stale = New-RunDirectory
if ((Invoke-D1File $stale $fixture) -ne 0) { throw 'stale fixture setup failed' }
if ((Invoke-D1File $stale (Join-Path $PSScriptRoot 'fixtures\quad3_stale.sql')) -ne 0) { throw 'stale edit failed' }
if ((Invoke-D1File $stale $candidate) -eq 0) { throw 'stale candidate unexpectedly succeeded' }
$staleRows = Invoke-D1Query $stale "SELECT (SELECT COUNT(*) FROM album_display_groups WHERE id='ag-q3-flac-wav-20260926') AS groups, (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') AS pending;"
$staleText = $staleRows | Out-String
if ($staleText -notmatch '"groups"\s*:\s*0' -or $staleText -notmatch '"pending"\s*:\s*9') { throw 'stale rollback verification failed' }

$late = New-RunDirectory
if ((Invoke-D1File $late $fixture) -ne 0) { throw 'late fixture setup failed' }
$lateCandidate = Join-Path $late 'late.sql'
(Get-Content -Raw -LiteralPath $candidate).Replace("VALUES ('ag-q3-flac-wav-20260926', 'al-q3-wav-20260926', 1);", "VALUES ('ag-q3-flac-wav-20260926', 'al-1a27548730', 1);") | Set-Content -NoNewline -Encoding utf8 $lateCandidate
if ((Invoke-D1File $late $lateCandidate) -eq 0) { throw 'late candidate unexpectedly succeeded' }
$lateRows = Invoke-D1Query $late "SELECT (SELECT COUNT(*) FROM album_display_groups WHERE id='ag-q3-flac-wav-20260926') AS groups, (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') AS pending;"
$lateText = $lateRows | Out-String
if ($lateText -notmatch '"groups"\s*:\s*0' -or $lateText -notmatch '"pending"\s*:\s*9') { throw 'late rollback verification failed' }

[pscustomobject]@{ success = 'passed'; stale = 'rolled_back'; late = 'rolled_back' } | ConvertTo-Json
