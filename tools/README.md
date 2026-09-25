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

For `ARTIST` and `ALBUMARTIST`, the scalar ID3 display frames use ` / ` between distinct credits so the current Worker parser can read them without embedded NUL characters. Original Vorbis comment values, including composite forms, are retained in the matching `TXXX` frames and checked on readback. A comma-separated composite is folded into separate display names only when all those names also exist as distinct source values.

`flac_retention.metadata_preserved` describes metadata only. It is false when tags conflict, output verification fails, format parameters differ, or FLAC-only metadata remains. Even when true, the tool has not established FLAC/WAV audio identity: `external_pcm_match_required` stays true, and a separate decoded PCM hash comparison is required before any deletion decision. The [real-media sample report](../test/fixtures/real_flac_wav_sample_report.json) records that separate check for one Atlantis track and one Quadimension Q1 track.

Run the isolated tests from the repository root:

```powershell
py -3.11 -m unittest discover -s test/internal -p 'test_flac_tags_to_wav.py' -v
npx tsx --test test/internal/id3_multivalue_tags.test.ts
```

---

# Album merge preflight manifest

This local-only tool inspects a restored D1 SQLite snapshot and user-selected local R2 cache files. It writes a JSON manifest containing the matching object/instance/entry/master rows, shared-object references, foreign-key associations, song annotations, saved play queues, and work-queue rows that refer to candidate IDs.

It opens SQLite with `mode=ro` and `query_only`, uses no Wrangler/Cloudflare/R2 client, never changes audio inputs, and refuses to overwrite the output manifest. The result can report `ready_for_manual_review`; it never authorizes upload, object replacement, D1 writes, or deletion.

## Candidate input

Create a JSON file with one entry per exact WAV/FLAC pair. Resolve object identity by an exact `physical_key` from the supplied local snapshot; do not infer it from a filename. The expected SHA-256 values should come from an independently recorded copy/checksum step. The tool recomputes the local hashes and compares local byte sizes to `storage_objects.size`; D1 `etag` is included for reference but is never treated as SHA-256.

The tool also reads the existing `exact_wav_upload_manifest.json` directly. It expands each `exact_flacs` entry against its corresponding `tag_reports` entry, checks each report digest, and requires one report to match the manifest's selected output path/hash. It validates the manifest's declared SQLite snapshot path against `--db`. An optional `exact_wav_upload_status.json` is summarized as a supplied record only; no live upload state is queried.

```json
{
  "pairs": [
    {
      "label": "Album / track 01",
      "wav_cache": {
        "path": "C:/cache/objects/wav-copy.wav",
        "physical_key": "objects/<wav-object-id>.wav",
        "sha256": "<64 lowercase hex characters>"
      },
      "flac_cache": {
        "path": "C:/cache/objects/flac-copy.flac",
        "physical_key": "objects/<flac-object-id>.flac",
        "sha256": "<64 lowercase hex characters>"
      },
      "merged_wav": "C:/review/track-01-tagged.wav",
      "tag_merge_report": "C:/review/track-01-tag-merge-report.json"
    }
  ]
}
```

The tag report must be produced by `merge_flac_tags_to_wav.py` for the exact cached WAV and FLAC byte streams. The preflight verifies the report's source hashes, merged output path/hash/size, readback verification, preserved metadata, unresolved conflicts, PCM-chunk and non-ID3 RIFF guards, and pictures. It independently decodes WAV cache, FLAC cache, and merged WAV to signed 32-bit little-endian PCM with FFmpeg and compares sample rate, channels, frame count, and hash. `ffmpeg` and `ffprobe` must be available or supplied explicitly.

## Run

```powershell
py -3.11 tools/album_merge_preflight.py `
  --db C:/review/d1-snapshot.sqlite `
  --candidates C:/review/candidates.json `
  --output C:/review/preflight-manifest.json
```

To preflight the existing operations manifest:

```powershell
py -3.11 tools/album_merge_preflight.py `
  --db C:/Users/User/AppData/Local/Temp/edgesonic-album-merge-rehearsal-20260925.sqlite `
  --candidates F:/Development/lsy-404@edgesonic/agents/455_[Operations]_重复专辑与品质合并/exact_wav_upload_manifest.json `
  --status F:/Development/lsy-404@edgesonic/agents/455_[Operations]_重复专辑与品质合并/exact_wav_upload_status.json `
  --output C:/review/exact-wav-preflight.json
```

Custom executable paths can be passed with `--ffmpeg` and `--ffprobe`. The manifest includes all D1 rows found by exact object keys plus all instances attached to discovered masters and all entries attached to discovered objects/instances. Polymorphic annotations, play queues, and work-queue JSON references are checked separately. Queue payload contents are not copied into the report; only matching identifiers and JSON paths are retained.

## Limits

- The local snapshot may be stale. This tool cannot prove the live D1 still matches it.
- `storage_objects` has no content SHA field. Expected cache SHA values must be supplied from an independent local transfer/checksum record.
- PCM identity is not a tag, semantic-version, or listening-quality judgment. Matching decoded PCM does not settle which metadata master or directory entry should remain.
- Review the full manifest and separately decide any reference/master/entry migration. This tool performs no upload, R2 replacement/deletion, D1 mutation, or cleanup.
