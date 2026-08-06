# Subsonic Source Routing V2

V2 extends V1 with bounded claim propagation and correction. It requires all
V1 shared transport and authentication rules.

## Additions

- Peer-scoped claim announcements and event IDs.
- Bounded gossip using event TTL, hop caps, peer rate limits, and seen-event
  deduplication.
- Reverse dependency indexes and `invalidateSongSource` propagation.
- `searchSourceRoutes` for source-aware search across trusted peers.
- Snapshot responses for partial discovery and retry.

## Correctness

Gossip and invalidation accelerate convergence only. Claims still expire and
are revalidated during discovery and terminal playback. An event is forwarded
at most once per node, never beyond its hop cap or expiry, and only to trusted
peers.

## V1 Interoperability

When a peer supports only V1, V2 nodes may use it as a relay or direct source
but must not send V2 announcements, invalidations, or cross-peer searches to
that peer.
