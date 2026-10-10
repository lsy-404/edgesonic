# Work Mode lossless browser fixture

This loopback-only harness generates a five-second tagged PCM WAV in memory. It exercises the real `runTask`, the Vite-built `taskExecutor` module worker, and the FFmpeg lossless engine. Its local upload route checks source/output SHA-256 values, matching decoded PCM hashes, sample format, exact source and output sizes, preserved native/common metadata, embedded cover art and lyrics, and the claim headers. It also confirms that altered lyric, cover, date, comment, descriptor, and custom-tag fixtures fail verification. It then simulates a registered upload acknowledgment and a successful task submission.

The fixture contains no real music. After a successful local upload, the generated source WAV, converted FLAC, and JSON evidence are saved under `test/artifacts/workmode-lossless-browser/` for local Worker endpoint testing.

Run from the repository root:

```powershell
pnpm exec vite --config test/workmode-lossless-browser/vite.config.mts
```

Open `http://127.0.0.1:4179/` and click **Start generated WAV conversion** for the isolated loopback adapter, or **Run through local D1/R2 endpoints** when the local Worker fixture is listening on port 8798. The second button seeds the generated WAV into local R2, proxies the signed source/upload/submit routes through the fixture origin, submits the result to local D1, then displays task/instance/entry/catalog readback. Both servers bind only to loopback. The converter fetches its existing pinned FFmpeg core assets from jsDelivr.
