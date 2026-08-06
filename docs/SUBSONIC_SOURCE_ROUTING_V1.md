# Subsonic Source Routing V1

V1 provides source-aware playback across configured, trusted peers. It uses
the shared rules in [the common protocol](SUBSONIC_SOURCE_ROUTING.md).

## Scope

- `sourceRouting` version 1 capability negotiation.
- Peer authentication, signed chain propagation, bounded discovery, and
  hop-by-hop relay.
- `getSourceRoutingInfo`, `getSongSources`, and `resolveSongRoute`.
- `getSong` and `stream` source selection with `source=auto`.
- Metadata matching, route scoring, and short-lived local route caches.

V1 does not broadcast claims, retain cross-peer dependency indexes, propagate
invalidations, or perform network-wide search. A missing terminal source is
marked unavailable only by the observing node and expires under the normal
claim TTL.

## Required Behavior

- Peers negotiate the highest common `sourceRouting` version; V1 is selected
  only when both peers advertise version 1.
- All routed playback uses relay. Direct client delivery is outside V1.
- Explicit source selection never falls back to another source.
- `source=auto` selects only verified local or relayed candidates.
- A final missing instance returns HTTP 404 with Subsonic error code 70.

## Compatibility

V1 adds no fields to standard Subsonic 1.16.1 responses. Source details are
returned only by extension endpoints. Clients and servers that do not advertise
V1 continue to use ordinary Subsonic requests.
