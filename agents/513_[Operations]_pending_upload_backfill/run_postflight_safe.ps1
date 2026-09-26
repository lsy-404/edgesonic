param(
  [string]$WranglerCli = 'C:\Users\User\AppData\Local\npm-cache\_npx\d77349f55c2be1c0\node_modules\wrangler\bin\wrangler.js',
  [string]$NodeExecutable = 'C:\Program Files\nodejs\node.exe',
  [string]$WranglerConfig = 'F:\Development\lsy-404@edgesonic\worker\wrangler.toml'
)
$ErrorActionPreference='Stop'
$base=Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot=Split-Path -Parent (Split-Path -Parent $base)
$manifestPath=Join-Path $base 'manifest_safe.json'
$manifestHash=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedManifest=(Get-Content -LiteralPath (Join-Path $base 'manifest_safe.sha256') -Raw).Split(' ')[0].Trim().ToLowerInvariant()
if($manifestHash -ne $expectedManifest){throw 'Manifest SHA does not match manifest_safe.sha256'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$candidateHash=(Get-FileHash -LiteralPath (Join-Path $base 'candidate_map_safe.json') -Algorithm SHA256).Hash.ToLowerInvariant()
if($candidateHash -ne $manifest.candidate_map_sha256){throw 'Candidate map SHA does not match manifest'}
function Invoke-ReadOnlySql([string]$Sql,[string]$Label){
  $command=($Sql -replace '\s+',' ').Trim()
  $raw=(& $NodeExecutable $WranglerCli d1 execute edgesonic-db --remote --config $WranglerConfig --command $command --json 2>&1) -join "`n"
  if($LASTEXITCODE -ne 0){throw "Wrangler SELECT failed for $Label : $raw"}
  $match=[regex]::Match($raw,'(?m)^\s*\[\s*\{')
  if(-not $match.Success){throw "No JSON result for $Label : $raw"}
  $calls=ConvertFrom-Json $raw.Substring($match.Index)
  if(@($calls | Where-Object { -not $_.meta.served_by_primary -or [int]$_.meta.rows_written -ne 0 }).Count -gt 0){throw "Result was not primary read-only for $Label : $raw"}
  return $calls
}
$receiptDir=Join-Path $base ('batches_safe\postflight_receipts_'+$manifestHash.Substring(0,12))
New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
$receipts=[System.Collections.Generic.List[object]]::new()
foreach($group in $manifest.groups){
  $file=Join-Path $repoRoot $group.files.postflight.path
  $fileHash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if($fileHash -ne $group.files.postflight.sha256){throw "Postflight SQL SHA mismatch: $($group.batch_id)"}
  $calls=Invoke-ReadOnlySql (Get-Content -LiteralPath $file -Raw) $group.batch_id
  $row=$calls[0].results[0]
  $ok=([string]$row.batch_id -eq $group.batch_id -and [int]$row.candidate_masters_in_target -eq [int]$group.master_count -and [int]$row.candidate_masters_still_pending -eq 0 -and [int]$row.target_album_rows -eq 1 -and [int]$row.stored_song_count -eq [int]$group.master_count -and [int64]$row.calculated_size -ge 0)
  $receipt=[ordered]@{batch_id=$group.batch_id;status=$(if($ok){'PASS'}else{'FAIL'});recorded_at_utc=[DateTime]::UtcNow.ToString('o');manifest_sha256=$manifestHash;postflight_sql_sha256=$fileHash;result=$row;meta=$calls[0].meta}
  $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $receiptDir ($group.batch_id+'.json')) -Encoding UTF8
  $receipts.Add([pscustomobject]@{batch_id=$group.batch_id;status=$receipt.status;masters=$group.master_count;result=$row})
  if(-not $ok){throw "Batch postflight mismatch: $($group.batch_id) $($row | ConvertTo-Json -Compress)"}
}
$global=[ordered]@{expected_candidate_masters=0;candidate_masters_moved=0;candidate_masters_still_pending=0;target_album_rows=0;targets_at_expected_size=0;live_pending_master_count=0}
foreach($r in $receipts){
  $global.expected_candidate_masters += [int]$r.masters
  $global.candidate_masters_moved += [int]$r.result.candidate_masters_in_target
  $global.candidate_masters_still_pending += [int]$r.result.candidate_masters_still_pending
  $global.target_album_rows += [int]$r.result.target_album_rows
  if([int]$r.result.stored_song_count -eq [int]$r.masters -and [int64]$r.result.calculated_size -ge 0){$global.targets_at_expected_size++}
}
$liveCalls=Invoke-ReadOnlySql "SELECT COUNT(*) AS live_pending_master_count FROM song_masters WHERE album_id='pending-uploads';" 'live pending count'
$global.live_pending_master_count=[int]$liveCalls[0].results[0].live_pending_master_count
$expectedExcluded=$manifest.excluded_snapshot_count
if([int]$global.expected_candidate_masters -ne [int]$manifest.candidate_count -or [int]$global.candidate_masters_moved -ne [int]$manifest.candidate_count -or [int]$global.candidate_masters_still_pending -ne 0 -or [int]$global.target_album_rows -ne [int]$manifest.target_album_count -or [int]$global.targets_at_expected_size -ne [int]$manifest.target_album_count){throw "Global candidate postflight mismatch: $($global | ConvertTo-Json -Compress)"}
$excludedIds=Get-Content -LiteralPath (Join-Path $base 'excluded_ids_safe.json') -Raw | ConvertFrom-Json
$excluded=[ordered]@{expected_excluded_snapshot_rows=$excludedIds.Count;excluded_snapshot_rows_found=0;excluded_snapshot_rows_still_pending=0;chunks=0}
for($i=0;$i -lt $excludedIds.Count;$i+=80){
  $slice=@($excludedIds | Select-Object -Skip $i -First 80)
  $quoted=($slice | ForEach-Object {"'"+($_ -replace "'","''")+"'"}) -join ','
  $res=Invoke-ReadOnlySql "SELECT COUNT(*) AS expected_rows,SUM(CASE WHEN album_id='pending-uploads' THEN 1 ELSE 0 END) AS still_pending FROM song_masters WHERE id IN ($quoted);" "excluded IDs $i"
  $excluded.excluded_snapshot_rows_found += [int]$res[0].results[0].expected_rows
  $excluded.excluded_snapshot_rows_still_pending += [int]$res[0].results[0].still_pending
  $excluded.chunks++
}
if([int]$global.expected_candidate_masters -ne [int]$manifest.candidate_count -or [int]$global.candidate_masters_moved -ne [int]$manifest.candidate_count -or [int]$global.candidate_masters_still_pending -ne 0 -or [int]$global.target_album_rows -ne [int]$manifest.target_album_count -or [int]$global.targets_at_expected_size -ne [int]$manifest.target_album_count){throw "Global candidate postflight mismatch: $($global | ConvertTo-Json -Compress)"}
if([int]$excluded.expected_excluded_snapshot_rows -ne $expectedExcluded -or [int]$excluded.excluded_snapshot_rows_found -ne $expectedExcluded -or [int]$excluded.excluded_snapshot_rows_still_pending -ne $expectedExcluded){throw "Excluded-snapshot postflight mismatch: $($excluded | ConvertTo-Json -Compress)"}
$summary=[ordered]@{status='PASS';recorded_at_utc=[DateTime]::UtcNow.ToString('o');manifest_sha256=$manifestHash;groups=$receipts.Count;masters=[int]$manifest.candidate_count;batches=$receipts;global_candidate_postflight=$global;excluded_snapshot_postflight=$excluded;primary_calls=($receipts.Count+1+$excluded.chunks);rows_written=0}
$summary | ConvertTo-Json -Depth 14 | Set-Content -LiteralPath (Join-Path $base 'postflight_execution_receipt.json') -Encoding UTF8
$summary | ConvertTo-Json -Depth 14
