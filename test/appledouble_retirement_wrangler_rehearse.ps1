$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$config = Join-Path $PSScriptRoot 'fixtures\appledouble_retirement.wrangler.toml'
$fixture = Join-Path $PSScriptRoot 'fixtures\appledouble_retirement_fixture.sql'
$candidate = Join-Path $repo 'agents\524_[Audit]_appledouble_audio_retirement\apply_guarded.sql'
$run = Join-Path $PSScriptRoot ('.appledouble-wrangler-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $run | Out-Null

function Invoke-D1([string] $persist, [string] $kind, [string] $value, [bool] $expectFailure = $false) {
  $args = @('wrangler', 'd1', 'execute', 'edgesonic-db', '--config', $config, '--local', '--persist-to', $persist, "--$kind", $value, '--json')
  $out = & npx.cmd @args 2>&1
  if ($expectFailure) {
    if ($LASTEXITCODE -eq 0) { throw "expected local D1 failure for $kind" }
    return $out
  }
  if ($LASTEXITCODE -ne 0) { throw "local D1 command failed: $out" }
  return $out
}

function New-Fixture([string] $name) {
  $persist = Join-Path $run $name
  New-Item -ItemType Directory -Force -Path $persist | Out-Null
  Invoke-D1 $persist 'file' $fixture | Out-Null
  return $persist
}

function Counts([string] $persist) {
  $sql = "SELECT (SELECT COUNT(*) FROM song_masters) AS masters,(SELECT COUNT(*) FROM song_instances) AS instances,(SELECT COUNT(*) FROM storage_entries WHERE id IN ('se-90c99a8efdcb4a8d8f98dae14c0b54f6','se-5f1eae6efc5c4b7da336d0c499c780f3')) AS leaves,(SELECT COUNT(*) FROM storage_objects) AS objects;"
  $json = (Invoke-D1 $persist 'command' $sql | Out-String | ConvertFrom-Json)
  return $json[0].results[0]
}

$success = New-Fixture 'success'
Invoke-D1 $success 'file' $candidate | Out-Null
$successCounts = Counts $success
if ($successCounts.masters -ne 0 -or $successCounts.instances -ne 0 -or $successCounts.leaves -ne 0 -or $successCounts.objects -ne 2) { throw 'success local D1 receipt is unexpected' }

$stale = New-Fixture 'stale'
Invoke-D1 $stale 'command' "UPDATE storage_entries SET path='stale' WHERE id='se-90c99a8efdcb4a8d8f98dae14c0b54f6';" | Out-Null
Invoke-D1 $stale 'file' $candidate $true | Out-Null
$staleCounts = Counts $stale
if ($staleCounts.masters -ne 2 -or $staleCounts.instances -ne 2 -or $staleCounts.leaves -ne 2 -or $staleCounts.objects -ne 2) { throw 'stale local D1 run did not roll back' }

Invoke-D1 $success 'file' $candidate $true | Out-Null
$lateCounts = Counts $success
if ($lateCounts.masters -ne 0 -or $lateCounts.instances -ne 0 -or $lateCounts.leaves -ne 0 -or $lateCounts.objects -ne 2) { throw 'late local D1 run changed the completed state' }

Write-Output 'Wrangler local success, stale, and late rehearsals passed'
