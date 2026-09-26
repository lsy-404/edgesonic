$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $root 'worker'
$fixture = Join-Path $PSScriptRoot 'fixtures\chromatic_side_editions_local.sql'
$candidate = Join-Path $root 'agents\529_[Operations]_pending_side_editions\apply_chromatic_wav_guarded.sql'
$config = Join-Path $PSScriptRoot 'fixtures\quad3_wrangler.toml'
$wavId = 'al-chromatic-wav-20260926'
$groupId = 'ag-chromatic-audio-versions-20260926'

function Invoke-D1File([string]$persist, [string]$file) {
  Push-Location $worker
  try {
    $output = & npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --file $file --json 2>$null | Out-String
    $code = $LASTEXITCODE
    return @{ Code = $code; Output = $output }
  } finally { Pop-Location }
}
function Invoke-D1Query([string]$persist, [string]$sql) {
  Push-Location $worker
  try {
    $output = & npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --command $sql --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'local D1 query failed' }
    $parsed = ConvertFrom-Json -AsHashtable -InputObject $output
    if ($parsed -is [System.Collections.IDictionary]) { return $parsed.results[0] }
    return $parsed[0].results[0]
  } finally { Pop-Location }
}
function New-Persist { Join-Path ([System.IO.Path]::GetTempPath()) ('edgesonic-chromatic-' + [guid]::NewGuid().ToString('N')) }

$success = New-Persist
if ((Invoke-D1File $success $fixture).Code -ne 0) { throw 'local fixture failed' }
if ((Invoke-D1File $success $candidate).Code -ne 0) { throw 'candidate failed on exact fixture' }
$ok = Invoke-D1Query $success "SELECT (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='$groupId') members,(SELECT COUNT(*) FROM song_masters WHERE album_id='$wavId') wav_count,(SELECT COUNT(*) FROM song_masters WHERE album_id='al-9c7ec22ef5') flac_count,(SELECT duration FROM albums WHERE id='al-9c7ec22ef5') flac_cache_duration,(SELECT size FROM albums WHERE id='al-9c7ec22ef5') flac_cache_size,(SELECT song_count FROM albums WHERE id='$wavId') wav_cache_count,(SELECT duration FROM albums WHERE id='$wavId') wav_cache_duration,(SELECT size FROM albums WHERE id='$wavId') wav_cache_size,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_size,(SELECT COUNT(*) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_objects so ON so.id=si.storage_object_id JOIN storage_entries se ON se.instance_id=si.id WHERE sm.album_id='$wavId' AND sm.track BETWEEN 1 AND 12 AND sm.disc IN (1,2) AND si.suffix='wav') identities;"
if ($ok.members -ne 2 -or $ok.wav_count -ne 24 -or $ok.flac_count -ne 24 -or $ok.flac_cache_duration -ne 5171 -or $ok.flac_cache_size -ne 1166586233 -or $ok.wav_cache_count -ne 24 -or $ok.wav_cache_duration -ne 5212 -or $ok.wav_cache_size -ne 919762416 -or $ok.pending_count -ne 0 -or $ok.pending_duration -ne 0 -or $ok.pending_size -ne 0 -or $ok.identities -ne 24) { throw "success postcondition failed: $($ok | ConvertTo-Json -Compress)" }

$stale = New-Persist
if ((Invoke-D1File $stale $fixture).Code -ne 0) { throw 'stale fixture failed' }
$staleEdit = Join-Path $stale 'stale.sql'
"UPDATE storage_entries SET path=path||' stale' WHERE id='se-1e82fe555a554ba0a7621aebc58bc4ff';" | Set-Content -LiteralPath $staleEdit -Encoding utf8
if ((Invoke-D1File $stale $staleEdit).Code -ne 0) { throw 'stale mutation failed' }
if ((Invoke-D1File $stale $candidate).Code -eq 0) { throw 'stale candidate unexpectedly succeeded' }
$staleState = Invoke-D1Query $stale "SELECT (SELECT COUNT(*) FROM album_display_groups WHERE id='$groupId') groups,(SELECT COUNT(*) FROM albums WHERE id='$wavId') wav_albums,(SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending;"
if ($staleState.groups -ne 0 -or $staleState.wav_albums -ne 0 -or $staleState.pending -ne 24) { throw 'stale snapshot did not roll back' }

$late = New-Persist
if ((Invoke-D1File $late $fixture).Code -ne 0) { throw 'late fixture failed' }
$lateBatch = Join-Path $late 'late-failure.sql'
$bytes = [System.IO.File]::ReadAllText($candidate,[System.Text.Encoding]::UTF8) + "`nINSERT INTO work_queue(id,status) VALUES('late-failure','invalid');`n"
[System.IO.File]::WriteAllText($lateBatch,$bytes,[System.Text.UTF8Encoding]::new($false))
if ((Invoke-D1File $late $lateBatch).Code -eq 0) { throw 'late failure batch unexpectedly succeeded' }
$lateState = Invoke-D1Query $late "SELECT (SELECT COUNT(*) FROM album_display_groups WHERE id='$groupId') groups,(SELECT COUNT(*) FROM albums WHERE id='$wavId') wav_albums,(SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_cache;"
if ($lateState.groups -ne 0 -or $lateState.wav_albums -ne 0 -or $lateState.pending -ne 24 -or $lateState.pending_cache -ne 24) { throw 'late failure did not roll back the complete batch' }

[pscustomobject]@{ success = 'passed'; stale_snapshot = 'rolled_back'; late_failure = 'rolled_back'; rows = 24; wav_duration = $ok.wav_cache_duration; wav_size = $ok.wav_cache_size } | ConvertTo-Json -Compress
