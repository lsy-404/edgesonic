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

## Compatibility notes

- Both JSON and XML serialisations are supported. `openSubsonicExtensions` is
  emitted as one element per extension with `versions` as child elements, which
  serialises to a JSON array of numbers rather than a string.
- Cover art is resolved for song ids as well as album ids, falling back to the
  album cover when a track carries no embedded artwork.
- Used with DSub, Symfonium, Substreamer and Sonixd.

## Not implemented

`transcodeOffset` and `indexBasedQueue` are not advertised.
