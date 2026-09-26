$ErrorActionPreference = 'Stop'
$task = $PSScriptRoot
$repo = Split-Path -Parent (Split-Path -Parent $task)
$apply = Join-Path $repo 'agents\529_[Operations]_pending_side_editions\apply_summer_vinyl_guarded.sql'
$config = Join-Path $task 'wrangler.toml'
$text = Get-Content -Raw -LiteralPath $apply -Encoding utf8
$coverPath = [regex]::Match($text, "path='([^']+)' AND object_id='obj_8e193f74e0f392d5'").Groups[1].Value
$first = $text.Substring(0, $text.IndexOf('), valid_source AS'))
$rows = [regex]::Matches($first, "\('([^']*)','([^']*)','([^']*)','([^']*)','([^']*)',(\d+),(\d+),'([^']*)'\)")
if ($rows.Count -ne 11) { throw "expected 11 fixture rows, got $($rows.Count)" }
$durations = @(283,210,178,199,311,182,213,228,183,208,227)
$sizes = @(50272832,60366498,31360570,52706662,54883766,32029976,61354028,40159696,64660702,59823884,40060562)
$schema = @"
CREATE TABLE albums (id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_name TEXT,cover_r2_key TEXT,song_count INTEGER,duration INTEGER,size INTEGER,created_at INTEGER,updated_at INTEGER);
CREATE TABLE song_masters (id TEXT PRIMARY KEY,album_id TEXT NOT NULL,title TEXT NOT NULL,track INTEGER,disc INTEGER,duration INTEGER,updated_at INTEGER);
CREATE TABLE storage_objects (id TEXT PRIMARY KEY,physical_key TEXT NOT NULL UNIQUE);
CREATE TABLE song_instances (id TEXT PRIMARY KEY,master_id TEXT NOT NULL,storage_object_id TEXT,storage_uri TEXT NOT NULL,missing INTEGER,size INTEGER);
CREATE TABLE storage_entries (id TEXT PRIMARY KEY,instance_id TEXT,object_id TEXT,path TEXT);
CREATE TABLE work_queue (id TEXT PRIMARY KEY,task_type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','claimed','completed','failed','canceled')));
INSERT INTO albums VALUES ('pending-uploads','Pending Uploads',NULL,NULL,652,143817,25247901901,0,0);
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<641) INSERT INTO song_masters SELECT 'fixture-' || x,'pending-uploads','fixture',NULL,NULL,0,0 FROM n;
INSERT INTO storage_objects VALUES ('obj_8e193f74e0f392d5','objects/obj_8e193f74e0f392d5.jpg');
INSERT INTO storage_entries VALUES ('se-d7363341af824add92022d369be208ef',NULL,'obj_8e193f74e0f392d5','$coverPath');
"@
for ($i=0; $i -lt $rows.Count; $i++) {
  $m=$rows[$i].Groups
  $schema += "INSERT INTO storage_objects VALUES ('$($m[3].Value)','$($m[8].Value)');`n"
  $schema += "INSERT INTO song_masters VALUES ('$($m[1].Value)','pending-uploads','fixture',NULL,NULL,$($durations[$i]),0);`n"
  $schema += "INSERT INTO song_instances VALUES ('$($m[2].Value)','$($m[1].Value)','$($m[3].Value)','r2://$($m[8].Value)',0,$($sizes[$i]));`n"
  $schema += "INSERT INTO storage_entries VALUES ('$($m[4].Value)','$($m[2].Value)','$($m[3].Value)','$($m[5].Value)');`n"
}
function Invoke-D1([string]$persist,[string]$file) { & npx.cmd wrangler d1 execute DB --local --persist-to $persist --config $config --file $file | Out-Null; return $LASTEXITCODE }
function Query-D1([string]$persist,[string]$sql) { & npx.cmd wrangler d1 execute DB --local --persist-to $persist --config $config --command $sql --json }
$fixture=Join-Path $task '.fixture.sql'; $lateFile=Join-Path $task '.late.sql'
$success=Join-Path $task '.success'; $stale=Join-Path $task '.stale'; $late=Join-Path $task '.late'
foreach ($path in @($fixture,$lateFile,$success,$stale,$late)) {
  if (-not ([IO.Path]::GetFullPath($path).StartsWith(([IO.Path]::GetFullPath($task) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase))){ throw 'fixture cleanup path escaped test directory' }
}
Remove-Item -LiteralPath $fixture,$lateFile,$success,$stale,$late -Recurse -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $fixture -Value $schema -NoNewline -Encoding utf8
foreach($state in @($success,$stale,$late)){New-Item -ItemType Directory -Force $state|Out-Null; if((Invoke-D1 $state $fixture) -ne 0){throw 'fixture failed'}}
if((Invoke-D1 $success $apply) -ne 0){throw 'success candidate failed'}
$ok=(Query-D1 $success "SELECT (SELECT count(*) FROM song_masters WHERE album_id='al-summer-vinyl-20260926' AND disc=1 AND track BETWEEN 1 AND 5) a,(SELECT count(*) FROM song_masters WHERE album_id='al-summer-vinyl-20260926' AND disc=2 AND track BETWEEN 1 AND 6) b,(SELECT song_count FROM albums WHERE id='al-summer-vinyl-20260926') n,(SELECT duration FROM albums WHERE id='al-summer-vinyl-20260926') d,(SELECT size FROM albums WHERE id='al-summer-vinyl-20260926') s"|ConvertFrom-Json)[0].results[0]
if($ok.a -ne 5 -or $ok.b -ne 6 -or $ok.n -ne 11 -or $ok.d -ne 2422 -or $ok.s -ne 547679176){throw 'success assertion failed'}
Query-D1 $stale "UPDATE storage_entries SET path='stale.wav' WHERE id='se-8b488dcd38304e3d87b1cdd9c2d1f50c'"|Out-Null
if((Invoke-D1 $stale $apply) -eq 0){throw 'stale candidate unexpectedly succeeded'}
$bad=(Query-D1 $stale "SELECT count(*) n FROM albums WHERE id='al-summer-vinyl-20260926'"|ConvertFrom-Json)[0].results[0].n
if($bad -ne 0){throw 'stale transaction committed'}
Get-Content -LiteralPath $apply | Set-Content -LiteralPath $lateFile -NoNewline -Encoding utf8; Add-Content -LiteralPath $lateFile "`nSELECT * FROM intentional_late_failure;"
if((Invoke-D1 $late $lateFile) -eq 0){throw 'late candidate unexpectedly succeeded'}
$lateAlbum=(Query-D1 $late "SELECT count(*) n FROM albums WHERE id='al-summer-vinyl-20260926'"|ConvertFrom-Json)[0].results[0].n
if($lateAlbum -ne 0){throw 'late failure committed'}
Remove-Item -LiteralPath $fixture,$lateFile,$success,$stale,$late -Recurse -Force
Write-Output 'success, stale snapshot guard, and late rollback passed'
