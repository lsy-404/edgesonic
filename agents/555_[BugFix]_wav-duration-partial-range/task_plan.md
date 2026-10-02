# WAV partial-range duration regression

- [x] Confirm repository instructions and use the isolated task worktree.
- [x] Reproduce the 145 MB WAV failure using sparse head/tail range assembly and inspect the current music-metadata `WaveParser` behavior.
- [x] Implement the smallest safe WAV duration/bitrate fix using validated declared RIFF data lengths; do not synthesize huge gaps or buffers.
- [x] Add root `/test` regressions for the real-sized header/metadata range, small WAV, tail tags, and invalid/inconsistent RIFF data.
- [x] Run focused tests and required type/lint checks, record findings, and commit only scoped changes. Focused tests and diff checks pass; web typecheck cannot resolve the private UI package in this worktree.
