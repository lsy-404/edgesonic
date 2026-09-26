$ErrorActionPreference = 'Stop'
$task = $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $task)
$apply = Join-Path $repo 'agents\525_[Operations]_mixed_pending_album_repair\apply_qichengzhuanhe.sql'
$rollback = Join-Path $repo 'agents\525_[Operations]_mixed_pending_album_repair\rollback_qichengzhuanhe.sql'
$config = Join-Path $task 'wrangler.toml'
$fixture = Join-Path $task 'fixture.sql'
function Invoke-D1([string]$persist, [string]$file) { npx.cmd wrangler d1 execute edgesonic-mixed-album-fixture --local --persist-to $persist --config $config --file $file | Out-Null }
function Query-D1([string]$persist, [string]$sql) { npx.cmd wrangler d1 execute edgesonic-mixed-album-fixture --local --persist-to $persist --config $config --command $sql --json }
$success = Join-Path $task '.d1-success'
$stale = Join-Path $task '.d1-stale'
$late = Join-Path $task '.d1-late'
$lateFile = Join-Path $task '.late_failure.sql'
Remove-Item -LiteralPath $success,$stale,$late,$lateFile -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $success,$stale,$late | Out-Null
Invoke-D1 $success $fixture
Invoke-D1 $success $apply
$after = Query-D1 $success "SELECT (SELECT count(*) FROM song_masters WHERE album_id='al-qichengzhuanhe-wav' AND track BETWEEN 1 AND 7 AND disc=1) AS tracks,(SELECT cover_r2_key FROM albums WHERE id='al-qichengzhuanhe-wav') AS cover,(SELECT count(*) FROM storage_objects) AS objects"
if (($after | ConvertFrom-Json)[0].results[0].tracks -ne 7) { throw 'success track assertion failed' }
if (($after | ConvertFrom-Json)[0].results[0].cover -ne 'objects/obj_52c5c2fbd8c092f8.jpg') { throw 'success cover assertion failed' }
Invoke-D1 $success $rollback
$rolled = Query-D1 $success "SELECT (SELECT count(*) FROM albums WHERE id='al-qichengzhuanhe-wav') AS album,(SELECT count(*) FROM song_masters WHERE track IS NOT NULL OR disc IS NOT NULL) AS tracks,(SELECT count(*) FROM storage_objects) AS objects"
if (($rolled | ConvertFrom-Json)[0].results[0].album -ne 0) { throw 'rollback album assertion failed' }
if (($rolled | ConvertFrom-Json)[0].results[0].tracks -ne 0) { throw 'rollback track assertion failed' }
Invoke-D1 $stale $fixture
Query-D1 $stale "UPDATE song_masters SET album_id='stale' WHERE id='sm-upload-7848fe50-1d6'" | Out-Null
Invoke-D1 $stale $apply
$blocked = Query-D1 $stale "SELECT (SELECT count(*) FROM albums WHERE id='al-qichengzhuanhe-wav') AS album,(SELECT count(*) FROM song_masters WHERE id='sm-upload-05d63157-24d' AND album_id='pending-uploads' AND track IS NULL) AS unchanged"
if (($blocked | ConvertFrom-Json)[0].results[0].album -ne 0) { throw 'stale guard inserted album' }
if (($blocked | ConvertFrom-Json)[0].results[0].unchanged -ne 1) { throw 'stale guard changed a nonstale row' }
Invoke-D1 $late $fixture
Get-Content -LiteralPath $apply | Set-Content -LiteralPath $lateFile -NoNewline
Add-Content -LiteralPath $lateFile "`nSELECT * FROM intentional_late_failure;"
& npx.cmd wrangler d1 execute edgesonic-mixed-album-fixture --local --persist-to $late --config $config --file $lateFile | Out-Null
if ($LASTEXITCODE -eq 0) { throw 'late failure unexpectedly succeeded' }
$lateState = Query-D1 $late "SELECT (SELECT count(*) FROM albums WHERE id='al-qichengzhuanhe-wav') AS album,(SELECT count(*) FROM song_masters WHERE id='sm-upload-05d63157-24d' AND album_id='pending-uploads' AND track IS NULL AND disc IS NULL) AS unchanged"
if (($lateState | ConvertFrom-Json)[0].results[0].album -ne 0) { throw 'late failure committed album' }
if (($lateState | ConvertFrom-Json)[0].results[0].unchanged -ne 1) { throw 'late failure committed song change' }
Remove-Item -LiteralPath $success,$stale,$late,$lateFile -Recurse -Force
Write-Output 'success, stale guard, and late failure rollback passed'
