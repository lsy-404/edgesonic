# Findings

- Queue claims are fenced by monotonic `attempts` and second-resolution `claimed_at`; terminal restart must increase attempts to prevent a delayed same-second submit from replaying.
- Existing metadata results use durable apply markers and scheduled recovery; retrieval uses its own marker to avoid force-requeue while catalog application is pending.
- Retrieval covers are bounded to 200 KB, checked against PNG/JPEG/WebP signatures, and committed only while the original target master still belongs to the expected album and both song and album cover fields remain empty.
- Unknown placeholder album rows may be shared. A result must preserve known identity fields and split only the target master when recovering a missing album.
- Dispatch uses configured enabled providers and stable master-id pagination; the source instance URI and ETag fence application against moved/replaced files.
- Executor result contract permits omitted album only where both payload identity and raw snapshot lack a known album.
