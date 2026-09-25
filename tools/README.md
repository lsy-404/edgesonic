# Local FLAC-to-WAV tag merge

This utility reads one FLAC and one WAV from local paths, then writes a separate WAV with the FLAC Vorbis comments and pictures embedded in an ID3 chunk. It never edits either input and refuses to overwrite an existing output or report.

Install the pinned dependency:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
```

Run a merge:

```powershell
.\.venv\Scripts\python tools\merge_flac_tags_to_wav.py source.flac target.wav --output target.merged.wav
```

If existing WAV values conflict with FLAC values, the tool writes the JSON report and exits with status 2 without creating an audio output. Resolve only reviewed conflicts in a JSON file, using ID3 frame IDs for standard fields and `TXXX:<VORBIS_KEY>` for custom comments:

```json
{
  "TIT2": "flac",
  "TXXX:MOOD": ["calm", "bright"]
}
```

Each resolution may be `"wav"`, `"flac"`, a replacement string, or a replacement string list. Then pass `--resolve-json decisions.json`. The report records source values, conflicts, pictures, every FLAC metadata block, unmapped comment keys, and SHA-256 checks for PCM data and all non-ID3 RIFF chunks. Padding and seek tables are marked regenerable. STREAMINFO counts as metadata preserved only when sample rate, channel count, bit depth, and sample count match the WAV; application, cue sheet, unknown blocks, or unsupported picture types remain retention blockers.

`flac_retention.metadata_preserved` describes metadata only. It is false when tags conflict, output verification fails, format parameters differ, or FLAC-only metadata remains. Even when true, the tool has not established FLAC/WAV audio identity: `external_pcm_match_required` stays true, and a separate decoded PCM hash comparison is required before any deletion decision. The [real-media sample report](../test/fixtures/real_flac_wav_sample_report.json) records that separate check for one Atlantis track and one Quadimension Q1 track.

Run the isolated tests from the repository root:

```powershell
py -3.11 -m unittest discover -s test/internal -p 'test_flac_tags_to_wav.py' -v
```
