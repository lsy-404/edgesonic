# Findings

- Existing executor searched up to 20 results per provider, discarded candidates unless they met automatic credibility rules, and returned terminal `no-match` for ambiguous/no-credible results.
- Known identity and snapshot constraints are compared using the shared normalized identity functions. Automatic matching additionally requires a known artist or album anchor.
- Candidate review must preserve plausible results even if they are not credible enough for automatic application; selected detail resolution must still reject conflicts with every known title, artist, and album.
