$ErrorActionPreference='Stop'
$base='agents/513_[Operations]_pending_upload_backfill'
$node='C:\Program Files\nodejs\node.exe'
$wrangler='C:\Users\User\AppData\Local\npm-cache\_npx\d77349f55c2be1c0\node_modules\wrangler\bin\wrangler.js'
$outDir=Join-Path $base 'stripped_title_results';New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Get-ChildItem -LiteralPath (Join-Path $base 'stripped_title_queries') -Filter '*.sql' | Sort-Object Name | ForEach-Object {
 $sql=(Get-Content -LiteralPath $_.FullName -Raw) -replace '\s+',' '
 $raw=(& $node $wrangler d1 execute edgesonic-db --remote --config 'F:/Development/lsy-404@edgesonic/worker/wrangler.toml' --command $sql --json 2>&1) -join "`n"
 if($LASTEXITCODE -ne 0){throw "query failed $($_.Name): $raw"}
 $m=[regex]::Match($raw,'(?m)^\s*\[\s*\{');if(-not $m.Success){throw "no JSON: $raw"}
 $parsed=ConvertFrom-Json $raw.Substring($m.Index)
 if(-not $parsed[0].meta.served_by_primary -or [int]$parsed[0].meta.rows_written -ne 0){throw "not primary read-only: $raw"}
 $parsed | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outDir ($_.BaseName+'.json')) -Encoding UTF8
 Write-Output ($_.Name+': '+$parsed[0].results.Count+' hits')
}

