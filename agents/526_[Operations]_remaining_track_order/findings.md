# Findings

- Four imported albums have one physical source parent each. Their 36 filenames contain unique complete indices: FM404 1–9, Stay 1–7, 低语者 1–8, 如期归还 `Sec.1`–`Sec.12`.
- Every selected master had null `track` and `disc`. The source manifest includes exact master, album, instance, object, file-entry, parent, path, filename, and title snapshots. A mismatch causes the single update statement to write zero rows.
- The guarded candidate is `apply.sql`, SHA-256 `c83ee86990b971d51d7b66a33a88bd8f1fc6e200882bfc89b11956e40afc8e5e`; `rollback.sql` restores null indices only while the exact post-apply snapshot still matches.
- Production primary read-only preflight returned `expected_count=36`, `exact_ready=36`, `rows_written=0`.
- Production D1 apply exited successfully with `Rows written=36` and primary confirmation. Postflight primary returned `expected_count=36`, `exact_applied=36`, `rows_written=0`.
- Per-album postflight found 9, 7, 8, and 12 unique tracks respectively, all on disc 1 with contiguous indices. No master, instance, storage entry, object, title, album assignment, or R2 bytes changed.
