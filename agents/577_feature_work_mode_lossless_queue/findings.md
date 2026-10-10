# Server work mode and lossless queue

## Scope
Implement server task-type selection and a bounded lossless WAV-to-FLAC dispatch, claim, verified upload, and guarded catalog replacement. No live music or cloud mutations.

## Constraints
- Task type selection is independent from runtime capability.
- Only eligible original R2 WAV files enter the queue.
- Candidate query is bounded by the union of selected types; empty selection claims none.
- Upload applies only for the current claim and matching source snapshot, and only after verified FLAC evidence.
- Preserve master metadata, tags, artwork, lyrics, companions, and references; retire old objects only when unreferenced.
- Tests remain under /test. Root agent updates tasks index.

## Confirmed interface
- Executor POSTs raw FLAC to `uploadUrl` as `audio/flac`; headers: `X-Source-SHA256`, `X-Output-SHA256`, `X-Source-PCM-SHA256`, `X-Output-PCM-SHA256`, `X-Verification-JSON` (`sampleRate`, `channels`, `bitsPerSample`, `sourceBytes`, `outputBytes`, `metadataPreserved:true`), `X-Work-Attempt`, and `X-Work-Claimed-At`.
- Task enqueue payload snapshots `sourceUri`, `instanceId`, `sourceSize`, `sourceEtag`, `sourceObjectId`. Claim payload adds exact-instance `streamUrl` and signed `uploadUrl`.
- Upload verifies source stream SHA, uploaded FLAC SHA and STREAMINFO, and exact active claim/source snapshot before switching catalog pointers. A successful upload is the only path marking the task completed.
