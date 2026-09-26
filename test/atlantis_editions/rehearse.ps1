$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$workerPath = Join-Path $repoRoot 'worker'
$configPath = Join-Path $PSScriptRoot 'wrangler.toml'
$seedPath = Join-Path $PSScriptRoot 'seed.sql'
$migrationPath = Join-Path $repoRoot 'worker\migrations\0042_album_display_groups.sql'
$candidatePath = Join-Path $repoRoot 'agents\533_[Operations]_atlantis_multi_version\atlantis_display_group_candidate.sql'
$receiptPath = Join-Path $repoRoot 'agents\533_[Operations]_atlantis_multi_version\local_wrangler_rehearsal_receipt.json'
$baseAlbum = 'al-eddee4ba83'
$bracketedAlbum = 'al-atlantis-bracketed-edition'
$altMixAlbum = 'al-atlantis-unbracketed-track3'
$groupId = 'group-atlantis-editions'
$sentinel = 'codex-merge-guard-fail'
$expectedGroupNameHex = 'E4BA9AE789B9E585B0E89282E696AF2041746C616E746973'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('edgesonic-atlantis-rehearsal-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$report = [ordered]@{ schema = 'local-wrangler-d1-v1'; candidate_file = 'atlantis_display_group_candidate.sql'; scenarios = [ordered]@{} }

function Get-JsonArray($text) {
    $matches = [regex]::Matches($text, '(?m)^\[\s*$')
    if ($matches.Count -eq 0) { throw "Wrangler output did not contain a JSON array tail: $text" }
    $start = $matches[$matches.Count - 1].Index
    $tail = $text.Substring($start).Trim()
    if (-not $tail.EndsWith(']')) { throw 'Wrangler JSON tail is incomplete' }
    $parsed = ConvertFrom-Json -InputObject $tail -AsHashtable
    return @{ parsed = $parsed; tail = $tail }
}

function Invoke-D1($scenario, $label, $filePath, $commandText) {
    $persistPath = Join-Path $tempRoot $scenario
    $cliArgs = @('wrangler','d1','execute','edgesonic-db','--local','--config',$configPath,'--persist-to',$persistPath)
    if ($filePath) { $cliArgs += @('--file',$filePath) }
    if ($commandText) { $cliArgs += @('--command',$commandText) }
    $cliArgs += '--json'
    Push-Location $workerPath
    try {
        $lines = & npx.cmd @cliArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $text = ($lines | ForEach-Object { [string]$_ }) -join "`n"
    $entry = [ordered]@{ exit_code = $code; output = $text }
    if ($code -eq 0) {
        $jsonTail = Get-JsonArray $text
        $entry.json = $jsonTail.parsed
        $entry.json_tail_complete = $true
    } else {
        $entry.json_tail_complete = $false
    }
    $report.scenarios[$scenario].steps[$label] = $entry
    return $entry
}

function Add-Scenario($name) {
    $report.scenarios[$name] = [ordered]@{ steps = [ordered]@{} }
}

function Get-Summary($scenario) {
    $sql = "SELECT (SELECT COUNT(*) FROM album_display_groups WHERE id='$groupId') groups,(SELECT COUNT(*) FROM album_display_group_members WHERE group_id='$groupId') members,(SELECT COUNT(*) FROM song_masters WHERE album_id='$baseAlbum') wav_masters,(SELECT COUNT(*) FROM song_masters WHERE album_id='$bracketedAlbum') bracketed_masters,(SELECT COUNT(*) FROM song_masters WHERE album_id='$altMixAlbum') alternate_mix_masters,(SELECT COUNT(*) FROM song_instances) instances,(SELECT COUNT(*) FROM storage_objects) objects,(SELECT COUNT(*) FROM storage_entries WHERE kind='file') entries,(SELECT COUNT(*) FROM clone_id_map) clone_rows,(SELECT COUNT(*) FROM work_queue WHERE id='$sentinel') sentinel_rows"
    $result = Invoke-D1 $scenario 'summary' $null $sql
    if ($result.exit_code -ne 0) { throw 'local summary query failed' }
    $root = $result.json
    if ($root -is [System.Array]) { $root = $root[0] }
    return $root.results[0]
}

function Get-MetadataSnapshot($scenario) {
    $sql = "SELECT sm.id,sm.album_id,hex(CAST(sm.title AS BLOB)) title_hex,sm.track,sm.disc,sm.duration,hex(CAST(sm.participants AS BLOB)) participants_hex,hex(CAST(sm.lyrics AS BLOB)) lyrics_hex,hex(CAST(sm.lyrics_rich AS BLOB)) lyrics_rich_hex,si.id instance_id,si.suffix,si.size,si.missing,si.tag_scanned,si.storage_object_id,se.id entry_id,se.object_id entry_object_id,hex(CAST(se.path AS BLOB)) path_hex FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' ORDER BY sm.track,sm.id"
    $result = Invoke-D1 $scenario 'metadata_snapshot' $null $sql
    if ($result.exit_code -ne 0) { throw 'local metadata snapshot query failed' }
    $root = $result.json
    if ($root -is [System.Array]) { $root = $root[0] }
    return ConvertTo-Json -InputObject $root.results -Depth 12 -Compress
}

function Initialize-Scenario($name) {
    Add-Scenario $name
    $seed = Invoke-D1 $name 'seed' $seedPath $null
    if ($seed.exit_code -ne 0) { throw "$name seed failed: $($seed.output)" }
    $migration = Invoke-D1 $name 'migration' $migrationPath $null
    if ($migration.exit_code -ne 0) { throw "$name group schema failed: $($migration.output)" }
}

try {
    if (-not (Test-Path -LiteralPath $candidatePath)) { throw 'candidate SQL is missing' }

    Initialize-Scenario 'success'
    $before = Get-MetadataSnapshot 'success'
    $apply = Invoke-D1 'success' 'candidate' $candidatePath $null
    if ($apply.exit_code -ne 0) { throw "success candidate failed: $($apply.output)" }
    $after = Get-MetadataSnapshot 'success'
    $beforeRows = ConvertFrom-Json -InputObject $before -AsHashtable
    $afterRows = ConvertFrom-Json -InputObject $after -AsHashtable
    if ($beforeRows.Count -ne 17 -or $afterRows.Count -ne 17) { throw "success path retained before=$($beforeRows.Count) after=$($afterRows.Count) instances" }
    foreach ($index in 0..16) {
        foreach ($field in @('id','title_hex','track','disc','duration','participants_hex','lyrics_hex','lyrics_rich_hex','instance_id','suffix','size','missing','tag_scanned','storage_object_id','entry_id','entry_object_id','path_hex')) {
            if ($beforeRows[$index][$field] -cne $afterRows[$index][$field]) { throw "success path changed protected field $field" }
        }
    }
    $successSummary = Get-Summary 'success'
    if ($successSummary.groups -ne 1 -or $successSummary.members -ne 3 -or $successSummary.wav_masters -ne 8 -or $successSummary.bracketed_masters -ne 8 -or $successSummary.alternate_mix_masters -ne 1 -or $successSummary.instances -ne 17 -or $successSummary.objects -ne 17 -or $successSummary.entries -ne 17 -or $successSummary.clone_rows -ne 16 -or $successSummary.sentinel_rows -ne 0) { throw "success postcondition failed: $($successSummary | ConvertTo-Json -Compress)" }
    $report.scenarios.success.summary = $successSummary

    Initialize-Scenario 'stale'
    $staleFile = Join-Path $tempRoot 'stale.sql'
    [IO.File]::WriteAllText($staleFile, "UPDATE albums SET size=size+1 WHERE id='$baseAlbum';`n", [Text.UTF8Encoding]::new($false))
    $staleMutation = Invoke-D1 'stale' 'stale_snapshot_mutation' $staleFile $null
    if ($staleMutation.exit_code -ne 0) { throw 'stale setup mutation failed' }
    $staleApply = Invoke-D1 'stale' 'candidate' $candidatePath $null
    if ($staleApply.exit_code -eq 0) { throw 'stale snapshot was accepted' }
    $staleSummary = Get-Summary 'stale'
    $staleState = Invoke-D1 'stale' 'stale_state' $null "SELECT (SELECT size FROM albums WHERE id='$baseAlbum') base_size,(SELECT COUNT(*) FROM albums WHERE id IN ('$bracketedAlbum','$altMixAlbum')) new_albums,(SELECT COUNT(*) FROM song_masters WHERE album_id='$baseAlbum') base_masters,(SELECT COUNT(*) FROM album_display_groups WHERE id='$groupId') groups,(SELECT COUNT(*) FROM work_queue WHERE id='$sentinel') sentinels"
    $staleRoot = $staleState.json
    if ($staleRoot -is [System.Array]) { $staleRoot = $staleRoot[0] }
    $staleRow = $staleRoot.results[0]
    if ($staleRow.base_size -ne 579408906 -or $staleRow.new_albums -ne 0 -or $staleRow.base_masters -ne 17 -or $staleRow.groups -ne 0 -or $staleRow.sentinels -ne 0) { throw "stale transaction did not roll back: $($staleRow | ConvertTo-Json -Compress)" }
    $report.scenarios.stale.summary = $staleSummary
    $report.scenarios.stale.post_failure_state = $staleRow

    Initialize-Scenario 'late_failure'
    $lateFile = Join-Path $tempRoot 'late.sql'
    $candidateSql = [IO.File]::ReadAllText($candidatePath, [Text.Encoding]::UTF8)
    $lateSql = $candidateSql + "`nINSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES ('$groupId','$baseAlbum',99);`n"
    [IO.File]::WriteAllText($lateFile, $lateSql, [Text.UTF8Encoding]::new($false))
    $lateApply = Invoke-D1 'late_failure' 'candidate_then_duplicate_membership' $lateFile $null
    if ($lateApply.exit_code -eq 0) { throw 'late failure injection unexpectedly succeeded' }
    $lateSummary = Get-Summary 'late_failure'
    $lateState = Invoke-D1 'late_failure' 'post_failure_state' $null "SELECT (SELECT COUNT(*) FROM albums WHERE id='$baseAlbum' AND song_count=17 AND duration=4023 AND size=579408905 AND name=(SELECT CAST(X'E4BA9AE789B9E585B0E89282E696AF' AS TEXT))) source_album_restored,(SELECT COUNT(*) FROM albums WHERE id IN ('$bracketedAlbum','$altMixAlbum')) new_albums,(SELECT COUNT(*) FROM song_masters WHERE album_id='$baseAlbum') base_masters,(SELECT COUNT(*) FROM album_display_groups WHERE id='$groupId') groups,(SELECT COUNT(*) FROM album_display_group_members) members,(SELECT COUNT(*) FROM work_queue WHERE id='$sentinel') sentinels,(SELECT COUNT(*) FROM storage_objects) objects,(SELECT COUNT(*) FROM storage_entries WHERE kind='file') entries,(SELECT COUNT(*) FROM clone_id_map) clone_rows"
    $lateRoot = $lateState.json
    if ($lateRoot -is [System.Array]) { $lateRoot = $lateRoot[0] }
    $lateRow = $lateRoot.results[0]
    if ($lateRow.source_album_restored -ne 1 -or $lateRow.new_albums -ne 0 -or $lateRow.base_masters -ne 17 -or $lateRow.groups -ne 0 -or $lateRow.members -ne 0 -or $lateRow.sentinels -ne 0 -or $lateRow.objects -ne 17 -or $lateRow.entries -ne 17 -or $lateRow.clone_rows -ne 16) { throw "late failure did not roll back: $($lateRow | ConvertTo-Json -Compress)" }
    $report.scenarios.late_failure.summary = $lateSummary
    $report.scenarios.late_failure.post_failure_state = $lateRow

    $receiptJson = ConvertTo-Json -InputObject $report -Depth 30
    [IO.File]::WriteAllText($receiptPath, $receiptJson + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output 'Wrangler local rehearsal passed: success, stale guard rollback, late failure rollback; output tails parsed completely.'
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
    $resolvedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTemp.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
}
