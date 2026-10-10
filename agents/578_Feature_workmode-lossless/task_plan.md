# Work Mode lossless compression

- [x] Inspect the queued task wire payload, task runner lifecycle, converter verifier, and installed FFmpeg package.
- [x] Extract a reusable lossless conversion engine with source and decoded PCM hashes, format/profile and metadata evidence.
- [x] Add `lossless` dispatch, exact instance source stream URL augmentation, smaller-output validation, and signed immutable upload handling.
- [x] Keep cancellation/worker termination and FFmpeg asset cleanup correct on success and failure.
- [x] Add focused tests under `/test` for conversion and queued task behavior.
- [x] Run the focused checks and commit only scoped implementation and audit records.
