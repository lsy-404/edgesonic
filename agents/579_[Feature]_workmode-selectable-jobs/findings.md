# Findings

- Prior task 569 implemented a browser-local WAV-to-FLAC converter using existing ffmpeg.wasm and music-metadata dependencies; its audit says it validates PCM and metadata before download.
- Current worker selection is not persisted: the store advertises only runtime `caps` and has an ffmpeg capability gated on `SharedArrayBuffer` and cross-origin isolation.
- Parent task requires task types to be independent from runtime capability filtering; lossless selection must require explicit opt-in and unsupported options must explain why.
