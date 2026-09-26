$ErrorActionPreference='Stop'
$base=Split-Path -Parent $PSCommandPath
$scope=Get-Content -Raw -LiteralPath (Join-Path $base 'primary_scope.json')|ConvertFrom-Json
$pending=@($scope[0].results|Where-Object {$_.disc_folder -eq 'CD 1 人声碟'}|Sort-Object path)
$existing=@($scope[2].results|Sort-Object track)
if($pending.Count -ne 14 -or $existing.Count -ne 14){throw 'expected fourteen WAV and fourteen FLAC tracks'}
$out=Join-Path $base 'pcm_objects'
New-Item -ItemType Directory -Force -Path $out|Out-Null
$node='C:\Program Files\nodejs\node.exe'
$wrangler='C:\Users\User\AppData\Local\npm-cache\_npx\d77349f55c2be1c0\node_modules\wrangler\bin\wrangler.js'
$cfg='F:\Development\lsy-404@edgesonic\worker\wrangler.toml'
for($i=0;$i -lt 14;$i++){
  $track=$i+1
  $pairs=@(@($pending[$i]),@($existing[$i]))
  foreach($pair in $pairs){
    $kind=if($pair.suffix -eq 'wav'){'wav'}else{'flac'}
    $file=Join-Path $out ('{0:D2}.{1}' -f $track,$kind)
    if(Test-Path -LiteralPath $file){continue}
    & $node $wrangler r2 object get "edgesonic-music/$($pair.physical_key)" --remote --config $cfg --file $file
    if($LASTEXITCODE -ne 0){throw "download failed: $($pair.physical_key)"}
  }
}
