# Subsonic Source Routing Common Protocol

This document defines shared wire, authentication, matching, and relay rules
for the versioned `sourceRouting` OpenSubsonic extensions.

## Version Documents

- [V1: Basic Source Routing](SUBSONIC_SOURCE_ROUTING_V1.md)
- [V2: Claim Gossip and Correction](SUBSONIC_SOURCE_ROUTING_V2.md)
- [Direct Delivery Extension](SUBSONIC_DIRECT_DELIVERY.md)

## Compatibility

- Existing Subsonic endpoints retain their documented request and response
  shapes.
- Unknown query parameters are not a capability probe. Subsonic does not
  require implementations to ignore them.
- A peer supports this protocol only after its public
  `getOpenSubsonicExtensions` response advertises `sourceRouting` version 1.
- Extension endpoints use the normal `/rest/` envelope rules. Client-facing
  reads use regular Subsonic authentication; peer operations use the peer
  authentication scheme defined below.
- Standard clients do not call extension endpoints and receive the existing
  default source-selection behavior.

```xml
<openSubsonicExtensions name="sourceRouting">
  <versions>1</versions>
</openSubsonicExtensions>
```

The extension declaration contains no implementation-specific attributes.

## Version Negotiation

A peer selects the highest `sourceRouting` version present in both extension
lists. When there is no common version, source routing, peer relay, and
invalidation are disabled for that peer; ordinary Subsonic requests remain
available. All source-routing messages, including `invalidateSongSource`, use
the selected `sourceRouting` version. Version 1 has no separately negotiated
invalidation version.

## Terms

| Term | Meaning |
| --- | --- |
| node ID | Stable, public identifier of one service instance. It is not a credential. |
| source | A physical local instance or a verified route through a trusted peer. |
| claim | A time-limited assertion that a node can serve one matching song instance. |
| route | Ordered nodes from request entry to the node holding the selected instance. |
| chain | Ordered node IDs already visited by a request. It prevents loops. |
| predecessor | The direct peer that supplied a claim or forwarded the current request. |

## Capability and Node Information

### `getOpenSubsonicExtensions`

This existing public endpoint is the only capability probe. A caller treats a
missing endpoint, invalid response, or missing `sourceRouting` declaration as
unsupported.

### `getSourceRoutingInfo`

This peer-authenticated extension endpoint returns only information needed to
address a node. It does not disclose peers, libraries, claims, or credentials.

```xml
<subsonic-response status="ok" version="1.16.1">
  <sourceRoutingInfo nodeId="node-a" maxHops="4" maxCandidates="20"
                     maxPeersPerHop="3" maxDiscoveryTimeMillis="3000"
                     maxPeerProbeMillis="750" claimTtlSeconds="600"
                     maxRelayStreams="32" maxRelayKbps="51200"
                     matchingProfiles="metadata-v1" />
</subsonic-response>
```

## Standard Endpoint Additions

The following optional parameters are interpreted only by servers supporting
this extension. Their responses remain standard Subsonic 1.16.1 responses.

| Endpoint | Parameter | Meaning |
| --- | --- | --- |
| `getSong` | `source` | Select a local instance ID, local node ID, peer node ID, or `auto`. |
| `stream` | `source` | Select the source using the same values as `getSong`. |
| `getSong`, `stream` | `routePreference` | `local`, `hops`, `quality`, `balanced`, or `direct`. |
| `getSong`, `stream` | `maxHops` | Requested route cap. The server clamps it to its configured maximum. |
| `getSong`, `stream` | `minBitRate` | Hard minimum bitrate for automatic selection. |

Rules:

- An omitted `source` preserves existing source selection.
- `source=auto` resolves and chooses a route according to the preference.
- An explicit source never falls back to a different source or route.
- `source=<this node ID>` succeeds only if this node has a readable matching
  instance. Otherwise the response is standard error code `70` with HTTP 404.
- The `song` returned by `getSong` and bytes returned by `stream` describe the
  selected physical instance, including its standard size, suffix, content
  type, and bitrate fields.

Successful streams may add these ignorable response headers:

```text
X-Subsonic-Source: <source id>
X-Subsonic-Terminal-Node: <node id>
X-Subsonic-Route: <ordered node ids>
X-Subsonic-Route-Score: <integer>
```

## Data Plane Relay

Source routing version 1 uses hop-by-hop relay. It does not redirect a client
to the terminal node and does not expose peer credentials or terminal URLs.
Local storage optimizations, including a server's own signed-object redirect,
remain outside this protocol and must not be used for a routed peer source.

For a route `A,B,C`, A receives the client request and opens an authenticated
request to B; B then opens an authenticated request to C. Every relay streams
the downstream response body without buffering the complete object.

- The original `Range` and `If-Range` headers are forwarded unchanged.
- A relay preserves downstream `206`, `Content-Range`, `Content-Length`,
  `Accept-Ranges`, and `Content-Type` headers.
- A relay must not decode, transcode, or substitute another source unless the
  request explicitly allows it and the selected route describes that behavior.
- The selected source, format constraints, and chain are forwarded as signed
  peer request fields. The original end-user credential is never forwarded.
- A terminal `404` with Subsonic error code `70` is returned to the client and
  triggers route correction. An intermediary must not silently try another
  source for an explicit route.

### Relay Admission and Backpressure

A relay must account for every routed stream as both downstream ingress and
upstream egress. Before opening the downstream request it applies a local
concurrency limit, per-peer concurrency limit, and per-peer outbound bitrate
limit. The limits are implementation policy; `getSourceRoutingInfo` reports
the current total stream and aggregate bitrate limits to authenticated peers.
`maxRelayKbps` is measured in kilobits per second.

When admission fails, the relay returns HTTP 429 with a standard Subsonic error
code `0`, message `Relay capacity exceeded`, and a `Retry-After` header. A relay
may shape an admitted stream, but it must not alter byte order, ranges, or media
content. Shaping may use a sliding buffer no larger than 1 MiB per stream; once
full, the relay pauses reads from downstream until bytes are emitted. A relay
must never buffer a complete object. It should reserve capacity for local
playback so routed traffic cannot starve local users.

`availability="relay"` means the source has been verified as reachable by
this relay behavior, not that the client can directly fetch it.

This is an intentional v1 safety boundary. A direct-fetch mode requires an
explicit client opt-in, an audience-bound short-lived terminal authorization,
range-safe URL semantics, and terminal-node revocation rules. Those requirements
are not defined by version 1; a server must not advertise or infer direct fetch
from `sourceRouting` support.

## Extension Endpoints

### `getSongSources`

Returns known, matching physical and routed sources for a local song ID.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Local song ID. |
| `routePreference` | No | Ranking policy. Defaults to `balanced`. |
| `matchProfile` | No | Requested matching profile. Defaults to `metadata-v1`. |
| `maxHops` | No | Discovery cap. |
| `includeUnavailable` | No | Include `missing`, `stale`, and `unknown` claims. Defaults to false. |
| `includeRoute` | No | Include ordered node IDs. Defaults to false. |

```xml
<subsonic-response status="ok" version="1.16.1">
  <songSources songId="sm-1" preferredSource="route-peer-b">
    <source id="local-si-1" availability="available" nodeId="node-a"
            hops="0" size="123456" suffix="flac" contentType="audio/flac"
            bitRate="1000" transcodable="true" verifiedAt="2026-08-07T00:00:00Z" />
    <source id="route-peer-b" availability="relay" terminalNodeId="node-c"
            hops="2" size="654321" suffix="mp3" contentType="audio/mpeg"
            bitRate="320" transcodable="false" matchConfidence="0.96"
            verifiedAt="2026-08-07T00:00:00Z" expiresAt="2026-08-07T00:10:00Z" />
  </songSources>
</subsonic-response>
```

Availability values are `available`, `relay`, `missing`, `stale`, `unknown`,
and `unreachable`. Only `available` and `relay` may be selected automatically.

### `searchSourceRoutes`

Performs a source-aware search. It is separate from `search3` so that standard
search responses remain schema-compatible.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `query` | Yes | Search text. |
| `songCount` | No | Maximum song candidates. |
| `routePreference` | No | Ranking policy. |
| `matchProfile` | No | Requested matching profile. |
| `maxHops` | No | Discovery cap. |
| `includeUnavailable` | No | Include non-playable claims. |

The response contains standard song attributes under each result plus one or
more extension source records equivalent to `getSongSources`.

### `resolveSongRoute`

Resolves a playable route for one song without beginning playback.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Local song ID or peer-scoped song reference. |
| `routePreference` | No | Ranking policy. |
| `matchProfile` | No | Requested matching profile. |
| `maxHops` | No | Discovery cap. |
| `minBitRate` | No | Hard bitrate requirement. |

The selected candidate exposes its source ID, terminal node, hop count,
metadata confidence, validation time, and score. Ordered hops are emitted only
when `includeRoute=true`.

```xml
<subsonic-response status="ok" version="1.16.1">
  <sourceRoute songId="sm-1" sourceId="route-peer-b" availability="relay"
               terminalNodeId="node-c" hops="2" score="83"
               matchConfidence="0.96" suffix="mp3" contentType="audio/mpeg"
               bitRate="320" size="654321" verifiedAt="2026-08-07T00:00:00Z"
               expiresAt="2026-08-07T00:10:00Z">
    <route>
      <hop nodeId="node-a" />
      <hop nodeId="node-b" />
      <hop nodeId="node-c" />
    </route>
  </sourceRoute>
</subsonic-response>
```

The `route` element is omitted unless `includeRoute=true`. An unresolved route
uses the normal Subsonic error envelope rather than an empty successful result.

### `searchSourceRoutes` response

```xml
<subsonic-response status="ok" version="1.16.1">
  <sourceSearchResult query="example" complete="true" snapshotId="snapshot-1">
    <song id="sm-1" title="Example" artist="Artist" album="Album"
          duration="180" suffix="flac" contentType="audio/flac"
          bitRate="1000" size="123456">
      <sources preferredSource="route-peer-b">
        <source id="local-si-1" availability="available" nodeId="node-a"
                hops="0" suffix="flac" bitRate="1000" size="123456"
                matchConfidence="1.00" />
        <source id="route-peer-b" availability="relay" terminalNodeId="node-c"
                hops="2" suffix="mp3" bitRate="320" size="654321"
                matchConfidence="0.96" />
      </sources>
    </song>
  </sourceSearchResult>
</subsonic-response>
```

`complete="false"` means the discovery deadline expired after returning all
currently verified candidates. It does not make any omitted candidate negative.
An incomplete result must include `retryAfterMillis` between 250 and 5000. A
client may immediately play a returned route; otherwise it should repeat the
same request after that delay. Version 1 has no resumable discovery cursor, so
the retry is a fresh bounded discovery request. Every response is an atomic
snapshot identified by `snapshotId`; a client replaces, rather than merges, the
previous source list for that request. A client must not interrupt an active
stream because a newer snapshot differs, including when that snapshot marks its
route `missing`; it marks the route unavailable for future selection. Normal
stream failure and terminal invalidation rules still apply.

### `invalidateSongSource`

Authenticated peer-only POST used for reverse correction of a claim.

The request body must use `application/x-www-form-urlencoded; charset=UTF-8`.
Every listed parameter occurs exactly once. The body is encoded using the form
percent-encoding rules and `SHA256_HEX(BODY)` is computed over its exact raw
octets as transmitted, before parsing or normalization.

| Parameter | Required | Meaning |
| --- | --- | --- |
| `claimId` | Yes | Claimed instance assertion to invalidate. |
| `holderNodeId` | Yes | Node that reported the instance. |
| `songFingerprint` | Yes | Normalized metadata identity. |
| `reason` | Yes | `missing` or `metadataMismatch`. |
| `observedAt` | Yes | Unix milliseconds when the holder verified the state. |

The receiver accepts an invalidation only from a configured peer and only for a
known claim with the same holder and song fingerprint. `songFingerprint` uses
the serialization specified in [Matching](#matching). The signed chain header
is the reverse correction path. The receiver marks the claim
unavailable, invalidates dependent route cache entries, and forwards the same
event only to direct peers that received a dependent claim from it. Events are
idempotent by `claimId`, `reason`, and `observedAt`.

### Dependency Index

Every node that forwards or derives a claim maintains a reverse dependency
index. Each entry contains the upstream claim ID, the local derived claim or
route ID, the direct downstream peer ID, and an expiry. The entry must expire
no later than its derived claim and must be removed when that claim or route is
removed. Implementations must persist this index in their control-plane store;
an in-memory-only index is insufficient for reliable correction after restart.

Each upstream claim retains at most 256 downstream dependency entries. When the
cap is reached, the node may evict the least recently used entry, but all claims
remain subject to their normal expiry and revalidation. Reverse invalidation is
therefore an acceleration path, not the sole correctness mechanism. A receiver
forwards an event only through entries currently present in this index.

### Invalidation Rate Limits

Each peer is limited by a token bucket with capacity 300 and refill rate 120
events per minute. A receiver also accepts at most one state-changing
invalidation for the same `claimId` and reason in each five-minute window;
later observations update diagnostic time only. Requests exceeding either limit
receive HTTP 429, standard Subsonic error code `0`, and `Retry-After`. These
limits apply before reverse propagation.

## Peer Authentication and Trust

Peers are configured out of band with a peer ID and a distinct high-entropy
pre-shared secret. TLS is mandatory. Version 1 uses the following headers for
every peer request, including discovery, invalidation, and stream relay:

```text
X-Subsonic-Peer-Id: <configured peer id>
X-Subsonic-Peer-Timestamp: <unix milliseconds>
X-Subsonic-Peer-Nonce: <base64url random bytes>
X-Subsonic-Source-Chain: <comma-separated node IDs>
X-Subsonic-Peer-Signature: v1=<base64url HMAC-SHA-256>
```

The HMAC input is the UTF-8 string below, with literal newline separators:

```text
METHOD\n
PATH\n
CANONICAL_QUERY\n
TIMESTAMP\n
NONCE\n
CHAIN\n
SHA256_HEX(BODY)
```

`CANONICAL_QUERY` is the percent-encoded query sorted by encoded key and then
encoded value, retaining duplicate keys. The request body is empty for GET.
`CHAIN` is the exact ASCII value of `X-Subsonic-Source-Chain`. A node ID uses
only `[A-Za-z0-9._~-]`, has length 1 through 128, and each chain entry is
comma-separated with no whitespace or duplicate node IDs. An ingress node sets
its own ID as the initial chain. Each peer validates the signed chain, rejects a
chain containing its own ID, then appends its ID before forwarding.
Receivers must use constant-time signature comparison, reject timestamps more
than five minutes from local time, and retain each accepted peer ID/nonce pair
for ten minutes to reject replays. Each peer's nonce store is capped at 65,536
entries; it must reject new requests with HTTP 429 until an entry expires rather
than evicting a live nonce. A node authorizes a request only when the peer ID
and secret match an enabled local peer configuration.

Mutual TLS may be used in addition to this baseline. It does not replace the
signed envelope unless a later protocol version explicitly defines that mode.

## Discovery Budget

The ingress node sets an absolute `X-Subsonic-Discovery-Deadline` Unix
millisecond timestamp. Each receiver uses the earlier of that value and its own
configured maximum discovery duration; it never extends the deadline.

- The default maximum discovery duration is 3000 ms.
- A probe to one peer may consume at most 750 ms or the remaining deadline.
- Each node probes at most three eligible peers per hop and at most 20 total
  candidates for one request.
- Peers at the same hop are probed in parallel.
- A node returns verified partial results with `complete="false"` when its
  deadline expires. It never recursively retries within the same request.

## Discovery and Playback Chain

For a request entering A and traversing B to C, the chain is built as follows:

```text
A -> B: A
B -> C: A,B
C resolves a local instance: A,B,C
```

At every hop:

1. Reject the request when the incoming chain already contains this node ID.
2. Reject when the configured maximum hop count is reached.
3. Stop probing when the discovery deadline or candidate budget is exhausted.
4. Search local readable instances using the metadata matcher.
5. When local matching succeeds, create or refresh a claim for this node.
6. When it fails, ask only configured peers absent from the chain in parallel.
7. Return only continuous, verified candidate routes.

Playback repeats this validation hop-by-hop. A cached route is a preference,
not proof that the final node still has the file. The final node returns
standard code `70` and emits an invalidation if its claimed file is absent.

## Matching

A source claim uses a normalized metadata fingerprint comprising title, primary
artist, album, track number, disc number, and duration. Each text field is
normalized exactly as follows:

1. Apply Unicode NFKD normalization.
2. Remove code points in Unicode general category `M`.
3. Apply Unicode default case folding without locale-specific rules.
4. Replace every maximal run of code points outside `L` and `N` with one ASCII
   space.
5. Trim ASCII spaces and collapse remaining ASCII space runs to one space.

The protocol does not remove words such as `the`, does not expand abbreviations,
and does not infer featured artists. Track and disc values are non-negative
base-10 integers without leading zeroes. Duration is the integer floor in
seconds. The serialized fingerprint joins title, artist, album, track, disc,
and duration with U+001F; a missing field is an empty segment.

Automatic matching requires equal normalized title and primary artist. When
both durations are present, a difference greater than five seconds rejects the
candidate. Track, disc, and album disagreements do not reject a candidate; they
simply provide no corroboration. When either duration is missing, automatic
selection additionally requires an equal album, track, or disc value that is
present on both sides. Candidates without that corroborator have
`matchState="insufficientMetadata"` and may be reported only when
`includeUnavailable=true`.

The deterministic score is title 0.45, artist 0.35, duration 0.10 at a
difference up to two seconds or 0.07 at a difference up to five seconds, album
0.05 when equal, track 0.025 when equal, and disc 0.025 when equal. Missing and
unequal optional fields contribute zero. Automatic selection requires a score
of at least 0.80. This preserves title and artist as the identity anchor while
allowing incomplete or slightly divergent scans to contribute a viable route.

`metadata-v1` is the required interoperable matching profile. A server may
offer additional profiles through `matchingProfiles` in
`getSourceRoutingInfo`; an extension client must explicitly request a named
non-default profile using `matchProfile`. Results include `matchProfile`.
An extension endpoint receiving an unknown `matchProfile` returns HTTP 400 with
Subsonic error code `10` and does not fall back silently. A forwarding peer
preserves `matchProfile` unchanged and queries only peers that advertise it;
peers without it are excluded from that discovery branch. Unknown profiles in a
previously received result may be displayed but cannot be selected automatically.
This keeps the canonical profile portable while permitting libraries with better
domain metadata to choose a stricter local profile.

An existing content hash may raise confidence but is not required. Candidates
below the threshold may be shown to an extension client but cannot be selected
by `source=auto`.

## Route Selection

Routes are first filtered for continuous availability, no loop, hop cap,
metadata confidence, requested format, and `minBitRate`. Remaining routes are
scored by:

- local readability;
- fewer hops;
- requested format already present;
- no required transcoding;
- bitrate;
- recent successful validation.

`local` permits only local instances. `direct` permits the current node and one
trusted peer hop. `hops`, `quality`, and `balanced` adjust the hop and quality
weights without bypassing the filters.

## Cache and Invalidation

Routing control-plane data is separate from audio data.

| Data | Storage | Lifetime | Invalidated by |
| --- | --- | --- | --- |
| Peer extension capability | Control-plane cache | 24h for success or explicit unsupported; 5m for network failure | Peer configuration change or expiry |
| Node routing information | Control-plane cache | 24h | Node ID change or expiry |
| Positive claim | Control-plane cache | 10m | `missing`, `metadataMismatch`, expiry, or route failure |
| Negative claim | Control-plane cache | 30m | Fresh successful verification or expiry |
| Route candidate | Control-plane cache | At most the earliest claim expiry, capped at 10m | Any dependent claim invalidation |
| HTTP response for extension endpoints | Client cache | `Cache-Control: private, no-store` | N/A |

The data-plane cache and audio storage layer remain unchanged:

- Per-source cache tiers retain their configured byte budget, per-file cap,
  hard TTL, and LRU eviction behavior.
- Route discovery and source resolution never write media bytes to the
  data-plane cache.
- A route cache hit never extends an audio cache row's TTL.
- Route invalidation removes claims and routes only; it does not delete a valid
  local audio cache copy.
- A cached audio row is reported as local only while its object exists and its
  hard expiry has not passed.

## Errors

Use normal Subsonic error envelopes:

| Condition | HTTP | Code |
| --- | ---: | ---: |
| Missing required extension parameter | 400 | 10 |
| Untrusted peer attempts invalidation | 403 | 50 |
| Chain loop or hop cap | 403 | 50 |
| Explicit source or terminal instance missing | 404 | 70 |
| No route satisfies automatic constraints | 404 | 70 |
| Temporary peer failure | 502 | 0 |
| Relay, nonce, or invalidation admission limit | 429 | 0 |

Temporary failures must not be published as `missing` claims.
