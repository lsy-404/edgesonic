param(
  [string]$WranglerConfig = 'F:\Development\lsy-404@edgesonic\worker\wrangler.toml',
  [string]$WranglerCli = 'C:\Users\User\AppData\Local\npm-cache\_npx\d77349f55c2be1c0\node_modules\wrangler\bin\wrangler.js',
  [string]$NodeExecutable = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $base 'manifest_safe.json'
$dispositionsPath = Join-Path $base 'display_review_dispositions.json'
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$dispositions = Get-Content -LiteralPath $dispositionsPath -Raw | ConvertFrom-Json
$approvedIds = @($dispositions.safe_candidate_groups | ForEach-Object { $_.target_id })
$groups = @($manifest.groups | Where-Object { $approvedIds -contains $_.target_album_id })
if ($groups.Count -eq 0 -or $groups.Count -ne $manifest.target_album_count) { throw 'Safe review set and manifest do not match.' }
$receiptDir = Join-Path (Join-Path $base 'batches_safe') ('preflight_receipts_' + $manifestHash.Substring(0, 12))
New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
foreach ($group in $groups) {
  $file = Join-Path $base $group.files.preflight.path.Substring('agents/513_[Operations]_pending_upload_backfill/'.Length).Replace('/', '\')
  $sqlHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sqlHash -ne $group.files.preflight.sha256) { throw "Preflight SQL hash mismatch: $($group.batch_id)" }
  $expected = [int]$group.master_count
  $receiptPath = Join-Path $receiptDir ($group.batch_id + '.json')
  if (Test-Path -LiteralPath $receiptPath) {
    $prior = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($prior.manifest_sha256 -eq $manifestHash -and $prior.preflight_sql_sha256 -eq $sqlHash) {
      $results.Add([pscustomobject]@{ batch_id = $group.batch_id; status = $prior.status; masters = $expected; receipt = $receiptPath })
      continue
    }
    throw "Receipt does not match current manifest: $($group.batch_id)"
  }
  $sql = ((Get-Content -LiteralPath $file -Raw) -replace '\s+', ' ').Trim()
  $lines = & $NodeExecutable $WranglerCli d1 execute edgesonic-db --remote --config $WranglerConfig --command $sql --json 2>&1
  $exitCode = $LASTEXITCODE
  $raw = ($lines | ForEach-Object { "$_" }) -join "`n"
  if ($exitCode -ne 0) { throw "Wrangler SELECT failed for $($group.batch_id): $raw" }
  $jsonStart = [regex]::Match($raw, '(?m)^\s*\[\s*\{')
  if (-not $jsonStart.Success) { throw "No JSON result for $($group.batch_id): $raw" }
  $json = $raw.Substring($jsonStart.Index) | ConvertFrom-Json
  $call = $json[0]
  $row = $call.results[0]
  $expectedOther = @($group.expected_other_album_master_ids).Count
  $checks = [ordered]@{
    success = [bool]$call.success
    served_by_primary = [bool]$call.meta.served_by_primary
    rows_written_zero = ([int]$call.meta.rows_written -eq 0)
    exact_pending = ([int]$row.exact_pending_storage_matches -eq $expected)
    tag_snapshot = ([int]$row.metadata_snapshot_matches -eq $expected)
    no_target_collision = ([int]$row.target_album_rows -eq 0)
    no_title_conflict = ([int]$row.duplicate_title_groups -eq 0)
    no_track_conflict = ([int]$row.duplicate_disc_track_groups -eq 0)
    other_members_allowlisted = ([int]$row.other_album_members -eq $expectedOther -and [int]$row.allowlisted_other_members -eq $expectedOther -and [int]$row.unallowlisted_other_members -eq 0)
  }
  $status = if (($checks.Values | Where-Object { -not $_ }).Count -eq 0) { 'PASS' } else { 'FAIL' }
  $receipt = [ordered]@{
    batch_id = $group.batch_id
    status = $status
    recorded_at_utc = [DateTime]::UtcNow.ToString('o')
    manifest_sha256 = $manifestHash
    preflight_sql_sha256 = $sqlHash
    expected_masters = $expected
    expected_other_album_master_ids = @($group.expected_other_album_master_ids)
    checks = $checks
    result = $row
    meta = $call.meta
  }
  $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $results.Add([pscustomobject]@{ batch_id = $group.batch_id; status = $status; masters = $expected; receipt = $receiptPath })
  if ($status -ne 'PASS') { Write-Warning "Preflight blocker for $($group.batch_id): $($checks | ConvertTo-Json -Compress)" }
}
$summary = [ordered]@{
  status = if (@($results | Where-Object status -ne 'PASS').Count -eq 0) { 'PASS' } else { 'FAIL' }
  recorded_at_utc = [DateTime]::UtcNow.ToString('o')
  manifest_sha256 = $manifestHash
  groups = $results.Count
  masters = ($groups | Measure-Object -Property master_count -Sum).Sum
  receipts = @($results)
}
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $base 'preflight_summary_safe.json') -Encoding UTF8
$summary | ConvertTo-Json -Depth 12
