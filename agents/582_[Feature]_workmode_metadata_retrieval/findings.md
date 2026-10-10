# Findings

- Work Mode labels scrape as metadata retrieval but executor currently accepts only a generic URL and work/submit does not apply scrape results. Existing web scrape adapters already normalize provider search and detail results.
- Force means restart terminal per-master retrieval tasks even if prior retrieval failed or completed; active queued/claimed jobs must be retained without duplicate claims. Missing information alone is eligible; known fields and album identity must stay intact.
- Retrieval should fill only verified missing information. No-match/ambiguous results are recorded without changing the catalog. Source availability and source/master snapshot must guard delayed application.
- Sources remain Z-only for music; this implementation accesses repository and generated fixtures only. No real library batch needed for verification.

- Initial repository searches used Windows literal wildcard paths and stale guessed utility paths, yielding not-found/path-syntax errors; switched to rg glob-filtered directory searches and actual file inventory.
- Initial D1 request returned7403; global whoami confirmed account access and one immediate primary-query retry succeeded. No login/security settings changed.
- General scrape adapter proxy is /tag/scrape, not /rest/scrape. Unknown artist/album shared placeholders must never be renamed globally, and epoch-second updated_at alone cannot fence metadata edits.

[Regression] -> Existing lossless runner test suite failed both cases after eager globalThis.location.origin access was added for every task type -> Requested lazy scrape-only origin lookup and explicit scrape origin requirement; other task modes must remain location-independent in their unit environment. Existing queue, dedup, redispatch and metadata submit/recovery tests passed.

[Server transaction review] -> A master CAS may fail while followup statements still see the same updated_at second -> Requested catalog receipt immediately after successful master update using SQLite changes(), with all remaining D1 writes fenced by that receipt. Sources: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch ; https://www.sqlite.org/lang_corefunc.html#changes .
[Recovery review] -> Clearing an applying marker before setting retry could lose pending work, and a plain cover lease could lose catalog state -> Server followup retains pending on pre-batch errors and embeds catalog target/mode in stale-recoverable lease. Valid/invalid GIF agreement also reviewed to avoid permanent cover retries.
