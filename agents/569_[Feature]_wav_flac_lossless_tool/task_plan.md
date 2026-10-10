# WAV to FLAC lossless conversion

## Plan
- [x] Confirm latest main, existing audio dependencies, Tools UI seam, and worktree state.
- [x] Implement a local WAV-to-FLAC converter using the existing ffmpeg.wasm dependency.
- [x] Validate integer PCM input, codec stream properties, exact decoded PCM, and supported common metadata/art/lyrics before download.
- [x] Add English and Simplified Chinese UI text and focused /test coverage.
- [x] Run requested checks, review changes, and commit on the task branch.

## Follow-up: production browser verification
- [x] Reproduce the tagged WAV conversion and metadata assertion locally.
- [x] Keep an intact source buffer across ffmpeg.wasm transfer and allow the format-defined RIFF comment to FLAC description mapping.
- [x] Add a regression test that models transferable-buffer detachment and checks metadata preservation.
- [x] Run focused test and frontend typecheck, review, and commit.
