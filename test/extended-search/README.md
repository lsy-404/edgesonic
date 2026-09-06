# Local lyrics search verification

Run from the repository root. The fixture setup uses isolated local D1/R2 data
and an eight-second synthesized audio sample.

```sh
npm run build:web
node test/extended-search/seed.mjs
npx wrangler dev --config test/extended-search/wrangler.jsonc --local --ip 127.0.0.1 --port 8798 --persist-to test/extended-search/.wrangler/state
```

Sign in at `http://127.0.0.1:8798` with `search-test` / `lyrics-preview`.
In a second terminal, run `node test/extended-search/http-smoke.mjs` to verify
the real Worker search endpoints, bounded initialization, annotations and audio.
Run `npx tsx test/internal/lyrics_search_index.test.ts` for index lifecycle and
concurrency regressions.
