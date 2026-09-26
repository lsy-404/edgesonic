# Remote D1 batch rollback audit

Production verification on 2026-09-26 used the same Wrangler `d1 execute --remote --file` path as the guarded album batches. The controlled probe inserted two distinct canceled work-queue markers, then forced an integer-overflow error in the final statement. Wrangler exited with code 1 and reported the overflow. An independent primary D1 read returned zero rows for both marker IDs, with `rows_written=0` and `changed_db=false` for that read.

An initial probe using status `guard_failed` failed on the first statement because production `work_queue` permits only queued, claimed, completed, failed, and canceled statuses. That run did not test late rollback; the final probe uses valid canceled rows.

The remote-file path therefore rolled back earlier successful statements in this controlled late-failure case. Wrangler local execution can differ and must not be used as the sole proof of remote atomicity. Album candidates still require exact source guards, local success tests, a fresh production read-only preflight, and an independent production postflight.

Probe source: `test/d1_remote_atomicity_probe.sql`.
