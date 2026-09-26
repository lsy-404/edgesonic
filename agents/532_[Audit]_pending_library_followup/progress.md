# Progress

- Started a new audit branch from the latest main revision.
- Ran corrected local Wrangler stale and forced late-failure rehearsals; each rolled back cleanly.
- Ran primary-only production preflight and recorded current fields and expected aggregate cache deltas.
- Compared all thirteen 人声/言和 pairs through primary D1. Every WAV byte size differs, so no pair is eligible for byte-level duplicate retirement.
- Streamed all 26 R2 WAV objects into ffmpeg and recorded canonical PCM hashes; all thirteen pairs differ.
