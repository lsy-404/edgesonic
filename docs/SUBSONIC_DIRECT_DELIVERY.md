# Subsonic Direct Delivery Extension

`directDelivery` is an optional extension independent of `sourceRouting`. It
allows a client to fetch from a terminal source without carrying audio through
intermediate relays.

## Scope

The entry node and terminal node must both support `directDelivery` and agree
on a direct delegation. Intermediate nodes may relay discovery control traffic
but do not receive audio delivery credentials.

## Required Properties

- Explicit client opt-in.
- Terminal URL reachable by the client.
- Short-lived, resource-scoped, audience-bound terminal authorization.
- Range-safe delivery and expiry or revocation behavior.
- No fallback to redirect when negotiation fails; callers use normal relay.

The token format, terminal authorization exchange, and redirect response are
not defined in this initial extension document and require a separate versioned
wire specification before implementation.
