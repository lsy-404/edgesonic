# Work Mode metadata retrieval browser fixture

This loopback-only page runs the actual `runTask`, Vite module worker, `searchAll`, NetEase search/detail/lyric adapter, and same-origin `/tag/scrape` transport. The fixture replies locally for every provider request and records the compact result submitted to the mocked task endpoint.

The submit receipt is mocked. The fixture does not connect to D1 or R2 and does not claim catalog readback. No real provider or music files are used.

Run from the repository root:

```powershell
pnpm exec vite --config test/workmode-metadata-retrieval-browser/vite.config.mts
```

Open `http://127.0.0.1:4181/` and click **Run metadata retrieval fixture**. The report shows which provider intents ran, the submitted result, and the explicit absence of catalog readback.
