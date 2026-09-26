import hashlib
import json
import pathlib
import subprocess

base = pathlib.Path(__file__).parent
ffmpeg = r'F:\OneDrive - 510V\PATH\ffmpeg.exe'
records = []
for track in range(1, 15):
    result = {'track': track}
    for suffix in ('wav', 'flac'):
        source = base / 'pcm_objects' / f'{track:02d}.{suffix}'
        pcm = subprocess.check_output([ffmpeg, '-v', 'error', '-i', str(source), '-map', '0:a:0', '-f', 's32le', '-acodec', 'pcm_s32le', '-'])
        result[f'{suffix}_pcm_bytes'] = len(pcm)
        result[f'{suffix}_samples'] = len(pcm) // 8
        result[f'{suffix}_sha256'] = hashlib.sha256(pcm).hexdigest()
    result['pcm_equal'] = result['wav_pcm_bytes'] == result['flac_pcm_bytes'] and result['wav_sha256'] == result['flac_sha256']
    records.append(result)
receipt = {'canonical_format': 'decoded interleaved signed 32-bit little-endian PCM, two channels', 'tracks': records, 'all_equal': all(r['pcm_equal'] for r in records)}
(base / 'pcm_receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'all_equal': receipt['all_equal'], 'equal_tracks': sum(r['pcm_equal'] for r in records), 'tracks': len(records)}))
