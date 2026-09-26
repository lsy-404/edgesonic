$ErrorActionPreference='Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$task = Join-Path $root 'agents\534_[Audit]_maple_nighttread_dual_editions'
$testDir = $PSScriptRoot
$runId = Get-Date -Format 'yyyyMMddHHmmssfff'
$config = Join-Path $testDir 'wrangler.toml'
$apply = Join-Path $task 'artifacts\apply_guarded.sql'
$seed = Join-Path $testDir 'seed.sql'
$finger = Join-Path $testDir 'fingerprint.sql'
function Invoke-D1([string]$case,[string]$file,[string]$command) {
  $cliArgs = @('wrangler','d1','execute','maple-nighttread-rehearsal','--local','--config',$config,'--persist-to',(Join-Path $testDir ('state\'+$runId+'-'+$case)),'--json')
  if ($file) { $cliArgs += @('--file',$file) } else { $cliArgs += @('--command',$command) }
  $npxPath = (Get-Command npx).Path
  $out = & $npxPath @cliArgs 2>&1
  return @{ Exit=$LASTEXITCODE; Text=($out -join [Environment]::NewLine) }
}
function Fingerprint([string]$case) {
  $r = Invoke-D1 $case $finger $null
  if ($r.Exit -ne 0) { throw $r.Text }
  $matchJson = [regex]::Match($r.Text,'(?s)(\[\s*\{.*\}\s*\])')
  if (-not $matchJson.Success) { throw $r.Text }
  $obj = $matchJson.Groups[1].Value | ConvertFrom-Json
  $canonical = ConvertTo-Json -InputObject @($obj | ForEach-Object { ,$_.results }) -Compress -Depth 20
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical)))
}
function Seed([string]$case) {
  $r = Invoke-D1 $case $seed $null
  if ($r.Exit -ne 0) { throw $r.Text }
}
Seed 'success'
$r = Invoke-D1 'success' $apply $null
if ($r.Exit -ne 0) { throw ('success apply failed: '+$r.Text) }
$successFingerprint = Fingerprint 'success'
Seed 'sidecar-stale'
$r = Invoke-D1 'sidecar-stale' $null "UPDATE storage_objects SET physical_key='objects/changed-cover.jpg' WHERE id='obj_1b4a15b85d0840f4';"
if ($r.Exit -ne 0) { throw $r.Text }
$sidecarBefore = Fingerprint 'sidecar-stale'
$r = Invoke-D1 'sidecar-stale' $apply $null
if ($r.Exit -eq 0) { throw 'changed cover sidecar unexpectedly passed the identity guard' }
$sidecarAfter = Fingerprint 'sidecar-stale'
if ($sidecarBefore -ne $sidecarAfter) { throw 'stale cover sidecar scenario changed database state' }
Seed 'stale'
$r = Invoke-D1 'stale' $null "UPDATE storage_entries SET path='changed' WHERE id='se-e6a9e86da26846f68eaec39aa6475167';"
if ($r.Exit -ne 0) { throw $r.Text }
$staleBefore = Fingerprint 'stale'
$r = Invoke-D1 'stale' $apply $null
if ($r.Exit -eq 0) { throw 'stale apply unexpectedly succeeded' }
$staleAfter = Fingerprint 'stale'
if ($staleBefore -ne $staleAfter) { throw 'stale scenario changed database state' }
Seed 'concurrent'
$r = Invoke-D1 'concurrent' $null "UPDATE song_masters SET title=title||' changed' WHERE id='sm-upload-c94e08dc-ac5';"
if ($r.Exit -ne 0) { throw $r.Text }
$concurrentBefore = Fingerprint 'concurrent'
$r = Invoke-D1 'concurrent' $apply $null
if ($r.Exit -eq 0) { throw 'concurrent identity apply unexpectedly succeeded' }
$concurrentAfter = Fingerprint 'concurrent'
if ($concurrentBefore -ne $concurrentAfter) { throw 'concurrent scenario changed database state' }
$latePath = Join-Path $testDir 'apply_late_failure.sql'
(Get-Content -Raw -LiteralPath $apply)+[Environment]::NewLine+'SELECT abs(-9223372036854775808);'+[Environment]::NewLine | Set-Content -LiteralPath $latePath -Encoding utf8
Seed 'late'
$lateBefore = Fingerprint 'late'
$r = Invoke-D1 'late' $latePath $null
if ($r.Exit -eq 0) { throw 'late failure SQL unexpectedly succeeded' }
$lateAfter = Fingerprint 'late'
if ($lateBefore -ne $lateAfter) { throw 'late failure left partial database writes' }
[pscustomobject]@{result='PASS';successFingerprint=$successFingerprint;sidecarStaleRollback=($sidecarBefore -eq $sidecarAfter);staleRollback=($staleBefore -eq $staleAfter);concurrentRollback=($concurrentBefore -eq $concurrentAfter);lateRollback=($lateBefore -eq $lateAfter)} | ConvertTo-Json -Compress
