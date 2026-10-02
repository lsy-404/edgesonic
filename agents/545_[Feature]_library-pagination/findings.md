# Findings

- Existing normal songs and albums are fetched in fixed batches (`SONG_PAGE` 1000 and `ALBUM_PAGE` 100) as an IntersectionObserver sentinel approaches the list end.
- Artists load from a single `getArtists` request; starred artists, albums, and songs load together from `getStarred2`.
- Library-wide search results are a separate aggregate collection and must send the requested offset/count when navigating result pages.
- Existing sort and instrumental filtering are client-side; server paging must preserve requested order and compensate for hidden instrumentals.
- Album display groups merge related albums into one visual card; paginate display cards while retaining their constituent album records.