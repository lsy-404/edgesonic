$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $root 'worker'
$fixture = Join-Path $PSScriptRoot 'fixtures\companion_display_group_local.sql'
$candidate = Join-Path $root 'agents\532_[Operations]_companion_display_group\apply_guarded.sql'
$config = Join-Path $PSScriptRoot 'album_display_groups.wrangler.toml'
$wavId = 'al-zhongchong-instrumentals-20260926'
$groupId = 'ag-zhongchong-audio-versions-20260926'
$sourceAlbum = 'al-369dc39c99e3a1a27dc05b84aa30d1e1'
function Invoke-D1File([string]$persist,[string]$file) {
  Push-Location $worker
  try {
    $output = & npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --file $file --json 2>$null | Out-String
    $code = $LASTEXITCODE
    return @{ Code=$code; Output=$output }
  } finally { Pop-Location }
}
function Invoke-D1Query([string]$persist,[string]$sql) {
  Push-Location $worker
  try {
    $output = & npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --command $sql --json 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'local D1 query failed' }
    $parsed = ConvertFrom-Json -AsHashtable -InputObject $output
    if ($parsed -is [System.Collections.IDictionary]) { return $parsed.results[0] }
    return $parsed[0].results[0]
  } finally { Pop-Location }
}
function New-Persist { Join-Path ([System.IO.Path]::GetTempPath()) ('edgesonic-companion-' + [guid]::NewGuid().ToString('N')) }
function Get-DbFingerprint([string]$persist) {
  $tables=@('albums','song_masters','song_instances','storage_objects','storage_entries','album_display_groups','album_display_group_members','work_queue')
  $snapshot=[ordered]@{}
  foreach($table in $tables) {
    Push-Location $worker
    try {
      $output=& npx.cmd wrangler d1 execute DB --config $config --local --persist-to $persist --command "SELECT * FROM $table ORDER BY rowid;" --json 2>$null | Out-String
      if($LASTEXITCODE -ne 0) { throw "could not fingerprint $table" }
      $parsed=ConvertFrom-Json -AsHashtable -InputObject $output
      if($parsed -is [System.Collections.IDictionary]) { $snapshot[$table]=@($parsed.results[0]) }
      else { $snapshot[$table]=@($parsed[0].results) }
    } finally { Pop-Location }
  }
  $json=ConvertTo-Json -InputObject $snapshot -Compress -Depth 40
  $sha=[System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($json))
  return [Convert]::ToHexString($sha)
}
function Assert-Clean([string]$persist,[int]$pendingCount,[int]$cacheCount,[long]$pendingDuration,[long]$pendingSize) {
  $state=Invoke-D1Query $persist "SELECT (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='$groupId') members,(SELECT COUNT(*) FROM albums WHERE id='$wavId') new_album,(SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads') pending,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_cache_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_cache_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_cache_size,(SELECT duration FROM albums WHERE id='$sourceAlbum') source_cache_duration;"
  if ($state.members -ne 0 -or $state.new_album -ne 0 -or $state.pending -ne $pendingCount -or $state.pending_cache_count -ne $cacheCount -or $state.pending_cache_duration -ne $pendingDuration -or $state.pending_cache_size -ne $pendingSize -or $state.source_cache_duration -ne 0) { throw "rollback state mismatch: $($state | ConvertTo-Json -Compress)" }
}
$success=New-Persist
if ((Invoke-D1File $success $fixture).Code -ne 0) { throw 'local fixture setup failed' }
if ((Invoke-D1File $success $candidate).Code -ne 0) { throw 'candidate failed on exact snapshot' }
$ok=Invoke-D1Query $success "SELECT (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='$groupId') group_members,(SELECT COUNT(*) FROM song_masters WHERE album_id='$sourceAlbum') source_count,(SELECT duration FROM albums WHERE id='$sourceAlbum') source_duration,(SELECT COUNT(*) FROM song_masters WHERE album_id='$wavId') wav_count,(SELECT COUNT(DISTINCT track) FROM song_masters WHERE album_id='$wavId' AND disc=1 AND track BETWEEN 1 AND 10) track_count,(SELECT song_count FROM albums WHERE id='$wavId') wav_cache_count,(SELECT duration FROM albums WHERE id='$wavId') wav_cache_duration,(SELECT size FROM albums WHERE id='$wavId') wav_cache_size,(SELECT song_count FROM albums WHERE id='pending-uploads') pending_count,(SELECT duration FROM albums WHERE id='pending-uploads') pending_duration,(SELECT size FROM albums WHERE id='pending-uploads') pending_size,(SELECT COUNT(*) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_objects so ON so.id=si.storage_object_id JOIN storage_entries se ON se.instance_id=si.id AND se.object_id=so.id WHERE sm.album_id='$wavId') wav_identity_count;"
if ($ok.group_members -ne 2 -or $ok.source_count -ne 10 -or $ok.source_duration -ne 2010 -or $ok.wav_count -ne 10 -or $ok.track_count -ne 10 -or $ok.wav_cache_count -ne 10 -or $ok.wav_cache_duration -ne 2037 -or $ok.wav_cache_size -ne 387524512 -or $ok.pending_count -ne 539 -or $ok.pending_duration -ne 120034 -or $ok.pending_size -ne 20877833365 -or $ok.wav_identity_count -ne 10) { throw "success state mismatch: $($ok | ConvertTo-Json -Compress)" }

$stale=New-Persist
if ((Invoke-D1File $stale $fixture).Code -ne 0) { throw 'stale fixture setup failed' }
$mutation=Join-Path $stale 'stale.sql'
"UPDATE storage_entries SET path=path||' stale' WHERE id='se-4f5f3aeb367840b380d112ec14e1edcc';" | Set-Content -LiteralPath $mutation -Encoding utf8
if ((Invoke-D1File $stale $mutation).Code -ne 0) { throw 'stale mutation failed' }
if ((Invoke-D1File $stale $candidate).Code -eq 0) { throw 'stale candidate unexpectedly succeeded' }
Assert-Clean $stale 549 549 122071 21265357877

$conflict=New-Persist
if ((Invoke-D1File $conflict $fixture).Code -ne 0) { throw 'conflict fixture setup failed' }
$mutation=Join-Path $conflict 'conflict.sql'
"INSERT INTO albums VALUES('competitor-album','Competitor',NULL,NULL,NULL,NULL,0,0,0,0,0,0); UPDATE song_masters SET album_id='competitor-album',disc=1,track=1 WHERE id='sm-upload-952a4b01-774';" | Set-Content -LiteralPath $mutation -Encoding utf8
if ((Invoke-D1File $conflict $mutation).Code -ne 0) { throw 'conflict mutation failed' }
if ((Invoke-D1File $conflict $candidate).Code -eq 0) { throw 'concurrent identity change unexpectedly passed' }
Assert-Clean $conflict 548 549 122071 21265357877
$competitor=Invoke-D1Query $conflict "SELECT COUNT(*) count FROM song_masters WHERE album_id='competitor-album' AND id='sm-upload-952a4b01-774';"
if ($competitor.count -ne 1) { throw 'conflicting update was not preserved' }

$late=New-Persist
if ((Invoke-D1File $late $fixture).Code -ne 0) { throw 'late fixture setup failed' }
$lateSql=Join-Path $late 'late-failure.sql'
$bytes=[System.IO.File]::ReadAllText($candidate,[System.Text.Encoding]::UTF8)+"`nINSERT INTO work_queue(id,status) VALUES('late-failure','invalid');`n"
[System.IO.File]::WriteAllText($lateSql,$bytes,[System.Text.UTF8Encoding]::new($false))
$beforeFingerprint=Get-DbFingerprint $late
if ((Invoke-D1File $late $lateSql).Code -eq 0) { throw 'late failure batch unexpectedly succeeded' }
$afterFingerprint=Get-DbFingerprint $late
if ($beforeFingerprint -ne $afterFingerprint) { throw "late failure changed database fingerprint: before=$beforeFingerprint after=$afterFingerprint" }
Assert-Clean $late 549 549 122071 21265357877

[pscustomobject]@{success='passed';stale_snapshot='rolled_back';concurrent_change='rolled_back';late_failure='rolled_back';late_fingerprint_unchanged=$true;wav_count=$ok.wav_count;wav_duration=$ok.wav_cache_duration;wav_size=$ok.wav_cache_size;pending_count=$ok.pending_count;source_duration_cache=$ok.source_duration}|ConvertTo-Json -Compress
