# Findings

- The existing web scraper exposes `searchAll` and `resolveResult` for lrc, netease, qmusic, and kugou and supports an injected `ProxyFn`.
- The cookie-authenticated management endpoint accepts `POST /tag/scrape` with `{source, intent, query|songId}` and returns `{ok, data}`. It must be formed from the current origin rather than `restUrl`, which targets `/rest/*` routes.
- The server enqueue/apply contract includes derived `identity` anchors plus a separate raw D1 `snapshot` for stale checks; result application validates against identity and preserves existing D1 values.
- Search results are evidence candidates only. Matching requires an exact normalized title and every known artist/album anchor to agree, with at least one known artist or album anchor. Known raw snapshot fields also constrain the candidate.
- Cover reads are optional, only for a missing current cover, restricted to HTTPS and bounded image responses.
- The broader repository typecheck passed the worker and web projects but stopped in the installer because `@lsypkg/fluent/vue` is unavailable in the existing linked dependencies.
