$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$config = Join-Path $PSScriptRoot 'wrangler.jsonc'
$state = Join-Path $PSScriptRoot '.state'
$schema = Join-Path $repo 'worker\migrations\Schema.sql'
$fixture = Join-Path $PSScriptRoot 'fixture.sql'

New-Item -ItemType Directory -Force -Path $state | Out-Null

& npx wrangler d1 execute edgesonic-pressure-baseline-local --config $config --local --persist-to $state --file $schema
if ($LASTEXITCODE -ne 0) { throw 'Local canonical schema setup failed.' }

& npx wrangler d1 execute edgesonic-pressure-baseline-local --config $config --local --persist-to $state --file $fixture
if ($LASTEXITCODE -ne 0) { throw 'Local pressure fixture setup failed.' }

& npx wrangler d1 execute edgesonic-pressure-baseline-local --config $config --local --persist-to $state --command "SELECT (SELECT COUNT(*) FROM artists WHERE id LIKE 'pressure-artist-%') AS artists, (SELECT COUNT(*) FROM albums WHERE id LIKE 'pressure-album-%') AS albums, (SELECT COUNT(*) FROM song_masters WHERE id LIKE 'pressure-song-%') AS songs, (SELECT COUNT(*) FROM song_instances WHERE id LIKE 'pressure-instance-%' AND missing = 0) AS playable_instances;"
if ($LASTEXITCODE -ne 0) { throw 'Local pressure fixture verification failed.' }
