# Progress

- Added `album_year` to both joined song row projections.
- Mapped a non-null album year to `SubsonicChild.year`.
- Added SQLite-backed regression coverage for both query projections and unset years.
- Production revision 80bfa50b was verified by the root agent: album artist prefill works; RainCyclone year remained blank despite the catalog album year being 2025.
- Focused test and Worker typecheck pass.
- Ready to commit.
