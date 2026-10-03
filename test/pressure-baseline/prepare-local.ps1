$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$config = Join-Path $PSScriptRoot 'wrangler.jsonc'
$state = Join-Path $PSScriptRoot '.state'
$schema = Join-Path $repo 'worker\migrations\Schema.sql'
$fixture = Join-Path $PSScriptRoot 'fixture.sql'

if (-not (Test-Path -LiteralPath (Join-Path $repo 'web\dist\index.html'))) {
  throw 'Build the web application first with npm run build:web.'
}

New-Item -ItemType Directory -Force -Path $state | Out-Null

& wrangler d1 execute edgesonic-pressure-baseline-local --config $config --local --persist-to $state --file $schema
if ($LASTEXITCODE -ne 0) { throw 'Local canonical schema setup failed.' }

& wrangler d1 execute edgesonic-pressure-baseline-local --config $config --local --persist-to $state --file $fixture
if ($LASTEXITCODE -ne 0) { throw 'Local pressure fixture setup failed.' }

& wrangler d1 execute edgesonic-pressure-baseline-local --config $config --local --persist-to $state --command "SELECT (SELECT COUNT(*) FROM artists WHERE id LIKE 'pressure-artist-%') AS artists, (SELECT COUNT(*) FROM albums WHERE id LIKE 'pressure-album-%') AS albums, (SELECT COUNT(*) FROM song_masters WHERE id LIKE 'pressure-song-%') AS songs, (SELECT COUNT(*) FROM song_instances WHERE id LIKE 'pressure-instance-%' AND missing = 0) AS playable_instances;"
if ($LASTEXITCODE -ne 0) { throw 'Local pressure fixture verification failed.' }

& node (Join-Path $PSScriptRoot 'prepare-media.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Synthetic media preparation failed.' }
& wrangler r2 object put edgesonic-pressure-media-local/pressure/audio.wav --config $config --local --persist-to $state --file (Join-Path $state 'media\audio.wav') --content-type audio/wav
if ($LASTEXITCODE -ne 0) { throw 'Local audio fixture setup failed.' }
& wrangler r2 object put edgesonic-pressure-media-local/pressure/cover.png --config $config --local --persist-to $state --file (Join-Path $state 'media\cover.png') --content-type image/png
if ($LASTEXITCODE -ne 0) { throw 'Local cover fixture setup failed.' }
