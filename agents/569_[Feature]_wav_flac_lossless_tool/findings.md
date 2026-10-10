# Findings

## Scope
Browser-local WAV to FLAC conversion in Tools, producing a verified downloadable file. This change does not modify cloud objects, database rows, or storage migration state.

## Existing implementation
- `web/package.json` already depends on `@ffmpeg/ffmpeg` and `music-metadata`.
- `web/src/workers/taskExecutor.ts` uses `new FFmpeg()`, `load()`, `writeFile()`, `exec()`, and `readFile()` for browser transcoding.
- `/tools` is a Vue view with collapsible sections and bilingual locale keys.
- Existing local encrypted audio conversion uses a dedicated worker and downloadable output pattern.

## Correctness constraints
- WAV float samples cannot be represented losslessly in FLAC and must be rejected. Unsupported WAV codecs and malformed/truncated WAV input must fail closed.
- FLAC output must keep sample rate, channel count, and bits per sample. Exact decoded PCM must match; stream properties alone do not prove this.
- Preserve tags, embedded pictures, and lyrics. Compare parsed source/output metadata before allowing download.

## References
- ffmpeg.wasm official API docs: https://ffmpegwasm.netlify.app/docs/api/ffmpeg/classes/ffmpeg/
- ffmpeg.wasm official usage: https://ffmpegwasm.netlify.app/docs/getting-started/usage/
- FFmpeg official codec docs: https://www.ffmpeg.org/ffmpeg-codecs.html

## Validation findings
- Pinned FFmpeg core 0.12.10 ESM JS and WASM URLs both returned HTTP 200 and wildcard CORS headers. The worker explicitly supplies both URLs to `FFmpeg.load()`; it does not depend on implicit core defaults.
- Native FFmpeg conversion rehearsal used WAV tags for title, artist, and album. FLAC decoded PCM hash matched WAV (`a25c31aa472dd961a75fabd107f152eddf1b8843a2723b3d19018ec367dd7f91`); `music-metadata` confirmed supported metadata and stream properties.
- Initial metadata parser selection by MIME type failed with `UnsupportedFileTypeError: Guessed MIME-type not supported: audio/wav`. Passing the explicit `.wav`/`.flac` filename to the maintained parser selected the correct loaders.
- The first extensible PCM fixture used 8 bytes of data for a 24-bit stereo layout, which is not frame-aligned. The fixture now uses 12 bytes; the parser rejects non-frame-aligned data.
- `pnpm exec tsx test/wav_flac_conversion.test.ts`, `pnpm --dir web run typecheck`, and `pnpm --dir web run build` pass. Build reports existing warnings from `@clamber_l/crypto` browser `url` externalization and the existing >500 kB main chunk.
- The WAV parser requires the RIFF-declared boundary to match the full file and rejects unexplained trailing bytes; this prevents ignored post-container data from bypassing metadata checks.

## Production smoke follow-up
- `ffmpeg.writeFile` transfers `Uint8Array.buffer` to the FFmpeg worker. Passing the verification source directly detaches it before metadata validation, causing `music-metadata` to reject the empty buffer with `End-Of-Stream`. Pass a copy to `writeFile` so exact verification can read the original source.
- The valid tagged WAV parses correctly. RIFF INFO ICMT becomes Vorbis DESCRIPTION under FFmpeg's FLAC muxer, and music-metadata exposes the WAV text as common.comment but not FLAC common.comment. Preserve fail-closed metadata checks while recognizing this explicit cross-container mapping.
- The FLAC parser does not report `numberOfSamples`; derive it from parsed duration and sample rate for the container property check. The worker's exact decoded-PCM SHA-256 comparison remains the authoritative sample equality check.
