# OpenSubsonic support

EdgeSonic implements the Subsonic API v1.16.1 and the OpenSubsonic extensions on
top of it. Every response carries `openSubsonic="true"`, and
`getOpenSubsonicExtensions` advertises the list below.

## Advertised extensions

| Extension | Versions | Notes |
| --- | --- | --- |
| `apiKeyAuthentication` | 1 | `?apiKey=` replaces the `u`/`t`/`s` triplet |
| `tokenInfo` | 1 | `/rest/tokenInfo` resolves the calling credentials to their user |
| `formPost` | 1 | every mutating endpoint also accepts `application/x-www-form-urlencoded` POST |
| `songLyrics` | 1, 2 | `getLyricsBySongId`; v2 returns structured lines with offsets |

## Vendor extension

`edgeSonicCloneProxy` (version 1) is EdgeSonic-specific and is not part of the
OpenSubsonic specification. It advertises that this instance can act as a relay
for another Subsonic-compatible server and describes its merge policy. Clients
that do not recognise the name can ignore it — the extension list is additive by
design.

Responses also expose the instance UUID used for loop prevention, so two
EdgeSonic instances proxying to each other terminate the chain instead of
recursing.

## Lyrics search

`edgeSonicExtendedSearch` (version 1) advertises the optional `lyricsQuery`
parameter on `search2` and `search3`, including form POST and `.view` URLs.
This is an EdgeSonic vendor extension; the [OpenSubsonic search3 specification](https://opensubsonic.netlify.app/docs/endpoints/search3/)
does not define lyrics searching.

- Omit `lyricsQuery` or leave it blank for ordinary search.
- Supply `lyricsQuery` to return songs containing that literal lyrics phrase.
  A nonempty `query` additionally filters their titles. Artist and album results
  are empty in this mode.
- Search supports Chinese substrings, normalized Unicode, case-insensitive text,
  and stored translations. `%`, `_`, and quotes are literal characters.
- `songCount`, `songOffset`, and `songSort` apply to the matched songs. Queries
  are limited to 512 characters after normalization.
- Existing lyrics are indexed in bounded batches; inserts, edits, and deletions
  automatically update the index. While preparation is incomplete, the server
  returns HTTP 503 with `Retry-After: 5` and the Subsonic error message
  `edgeSonicLyricsSearchInitializing`.

Example: `/rest/search3?query=&lyricsQuery=moonlight&songCount=20` with the
client's usual authentication parameters. The web library exposes a separate
lyrics field through **Extended search**.

## Compatibility notes

- Both JSON and XML serialisations are supported. `openSubsonicExtensions` is
  emitted as one element per extension with `versions` as child elements, which
  serialises to a JSON array of numbers rather than a string.
- Cover art is resolved for song ids as well as album ids, falling back to the
  album cover when a track carries no embedded artwork.
- Used with DSub, Symfonium, Substreamer and Sonixd.

## Not implemented

`transcodeOffset` and `indexBasedQueue` are not advertised.
