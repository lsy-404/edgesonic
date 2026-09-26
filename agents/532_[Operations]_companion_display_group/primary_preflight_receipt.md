# Primary preflight receipt

The SELECT-only preflight was run against production primary after unrelated archive operations. All three queries reported `served_by_primary=true` and `rows_written=0`.

- Target identities: 20 rows returned, all 20 exact matches.
- Vocal album `al-369dc39c99e3a1a27dc05b84aa30d1e1`: cached `10 / 0 / 354704714`; actual `10 / 2010 / 354704714`.
- Pending cache and actual: `549 / 122071 / 21265357877`.
- Companion album, display group, and member conflicts: all zero.

The captured row details are preserved in `snapshot.json`; `preflight.sql` repeats the read-only identity, cache, and conflict checks for any final rerun.
