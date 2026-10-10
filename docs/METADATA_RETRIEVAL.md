# Metadata retrieval

Metadata retrieval uses the browser work pool. Enable participating workers under Work Mode, then enable automatic metadata retrieval from its settings. Automatic retrieval is off by default and also requires the server metadata scraping switch and at least one enabled provider.

The Worker scans up to 100 parsed original tracks per run and enqueues at most 20 tasks, with no more than 40 scrape tasks queued or claimed. An independent three-minute cron trigger advances a persisted cursor through the catalog. It skips original tracks until tag parsing marks them complete. Catalog metadata completeness is evaluated separately from tag parsing and task completion.

The status panel checks the stored title, track artist, album, album artist, year, lyrics and cover. Missing fields and placeholder identities remain incomplete even after upload parsing or a successful retrieval task. A field being present does not establish that it is correct. Retrieved values update the catalog; this workflow does not rewrite embedded tags in the original audio file.

Automatic matches may fill missing catalog fields after the existing source and catalog snapshot checks pass. Ambiguous or unconfirmed provider results remain in the review list. A reviewer can apply a saved candidate, keep the result without changing the catalog, or explicitly retry the task. Retries use a refreshed catalog and source snapshot.

Automatic scans do not reopen completed, pending or kept tasks. Force retrieval can restart terminal tasks with missing metadata while skipping active, pending and user-kept results. Provider failures use bounded queue retries. A participating browser must stay open to execute retrieval tasks; the server scheduler maintains the queue when no browser is participating.

The review controls use the existing `dispatch_work` permission. The service can be managed through `GET` and `POST /edgesonic/work/scrape/auto`; review status is available from `GET /edgesonic/work/scrape/status`, and review actions use `POST /edgesonic/work/scrape/review`.
