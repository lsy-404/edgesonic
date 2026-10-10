# Findings

- Existing standalone converter performs integer PCM WAV validation, FFmpeg FLAC encoding, decoded PCM SHA-256 equality and `music-metadata` field/artwork/chapter verification. Its worker fetches FFmpeg core assets from jsDelivr 0.12.10 and revokes object URLs in `finally`.
- Existing queue executor accepted metadata/transcode/scrape only. `taskRunner` augments metadata tasks with an instance-bound signed `stream` URL, keeps claims alive, and terminates the outer worker in `finally`.
- Confirmed queued lossless contract: payload carries `instanceId`, `sourceUri`, `sourceSize`, `sourceEtag`, `sourceObjectId`, and signed `uploadUrl`; runner adds `streamUrl`. Upload is raw FLAC with hash/profile evidence and attempt/claim headers; server confirms registration and exact instance in the response.
- Extracted the converter into a reusable worker-safe function; queued conversion runs directly inside the existing task worker. Shared FFmpeg loading supplies the known single-thread core assets, checks `exec` exit codes, and runs engine termination plus object URL release in `finally`.
- Cancellation now reaches source fetch, FFmpeg, and upload. The runner allows the worker a short cleanup window after cancellation, then terminates it; canceled tasks do not submit outcomes.
- Tests run: `pnpm exec tsx --test test/frontend/workmode_lossless_runner.test.ts`; `pnpm exec tsx test/wav_flac_conversion.test.ts`; `pnpm --dir web run typecheck`; `pnpm --dir web run build`. All passed. The lossless test covers exact instance URL/claim augmentation and cancellation behavior; existing converter tests cover WAV validation and metadata checks.

- Merged the selectable Work Mode UI commit; the former WAV-to-FLAC page wrapper and worker had no remaining references and were removed. Tightened transcode completion to require a successful registered receipt with an output instance ID and exact output byte count.
- The coordinator claim payload already contains a claim-bound signed `streamUrl`; the browser runner preserves it for lossless work, while metadata work continues to construct its existing stream URL.
- `music-metadata` exposes FFmpeg's FLAC `LYRICS-ENG` as a native tag rather than `common.lyrics`; browser extraction and server embedded-tag parsing recognize language-suffixed lyric keys.
- Synchronized ID3 `SYLT` carries event timestamps that the FLAC mapping does not preserve. The verifier rejects it safely. COMM comments with a non-English language or nonempty descriptor are also rejected because the output mapping carries only text.
- Unknown native fields are verified by tag identity and value. The generated browser fixture checks altered lyric, cover, date, comment, descriptor, and custom TXXX cases.
