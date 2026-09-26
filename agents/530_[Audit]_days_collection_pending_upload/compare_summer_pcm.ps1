$ErrorActionPreference = 'Stop'
$config = 'F:\Development\lsy-404@edgesonic\worker\wrangler.toml'
$ffmpeg = (Get-Command ffmpeg).Source
$ffprobe = Join-Path (Split-Path $ffmpeg) 'ffprobe.exe'
$inventory = (Get-Content -Raw -LiteralPath 'production_inventory.json' | ConvertFrom-Json).results
$rows = @($inventory | Where-Object { $_.path -like 'Days幻梦年华乐团合集/2-Summer Days/*' })
$mp3 = @($rows | Where-Object suffix -eq 'mp3')
$wav = @($rows | Where-Object suffix -eq 'wav')
$work = Join-Path $PWD 'pcm-cache'
New-Item -ItemType Directory -Force -Path $work | Out-Null
function Get-Audio([object]$row) {
  $destination = Join-Path $work "$($row.object_id).$($row.suffix)"
  if (-not (Test-Path -LiteralPath $destination)) {
    & npx wrangler r2 object get "edgesonic-music/$($row.physical_key)" --remote --config $config --file $destination | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "R2 read failed: $($row.object_id)" }
  }
  return $destination
}
function Get-Pcm([string]$file) {
  $meta = & $ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,channels,nb_frames,duration_ts -of json $file | ConvertFrom-Json
  $pcm = "$file.pcm"
  & $ffmpeg -v error -i $file -map 0:a:0 -f s16le -acodec pcm_s16le -y $pcm
  if ($LASTEXITCODE -ne 0) { throw "PCM decode failed: $file" }
  [pscustomobject]@{ hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $pcm).Hash.ToLower(); bytes=(Get-Item -LiteralPath $pcm).Length; sample_rate=$meta.streams[0].sample_rate; channels=$meta.streams[0].channels; duration_ts=$meta.streams[0].duration_ts; nb_frames=$meta.streams[0].nb_frames }
}
$result = foreach ($w in $wav | Sort-Object path) {
  $stem = ($w.title -replace '^\d+\s*', '').Replace(' Ver.Piano','ver.Piano')
  $m = @($mp3 | Where-Object { $_.title.Replace(' Ver.Piano','ver.Piano') -eq $stem })
  $wpcm = Get-Pcm (Get-Audio $w)
  if ($m.Count -eq 1) {
    $mpcm = Get-Pcm (Get-Audio $m[0])
    [pscustomobject]@{ wav_master=$w.master_id; mp3_master=$m[0].master_id; title=$w.title; wav=$wpcm; mp3=$mpcm; decoded_pcm_equal=($wpcm.hash -eq $mpcm.hash); duration_ts_equal=($wpcm.duration_ts -eq $mpcm.duration_ts) }
  } else {
    [pscustomobject]@{ wav_master=$w.master_id; mp3_master=$null; title=$w.title; wav=$wpcm; mp3=$null; decoded_pcm_equal=$false; duration_ts_equal=$false }
  }
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $PWD 'summer_pcm_comparison.json')
