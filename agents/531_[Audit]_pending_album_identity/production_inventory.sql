WITH roots(root) AS (VALUES
  ('幸福三部曲 - VOICEMITH/CD_mastered_CN'),
  ('蔗蓝的创作集1.0-蔗蓝（wav）'),
  ('夜幻寻梦    夢ノ結唱'),
  ('依路相随 CD/wav')
)
SELECT
  r.root,
  se.id AS entry_id,
  se.parent_id,
  se.path,
  se.display_name,
  se.kind,
  se.companion_of,
  se.object_id,
  se.instance_id,
  sm.id AS master_id,
  sm.album_id,
  al.name AS current_album,
  sm.artist_id,
  sm.album_artist_id,
  sm.title,
  sm.track,
  sm.disc,
  sm.duration AS master_duration,
  CASE WHEN sm.lyrics IS NULL THEN 0 ELSE 1 END AS has_lyrics,
  CASE WHEN sm.lyrics_rich IS NULL THEN 0 ELSE 1 END AS has_rich_lyrics,
  sm.cover_r2_key AS master_cover,
  si.source_id,
  si.source_type,
  si.storage_uri,
  si.suffix,
  si.size AS instance_size,
  si.duration AS instance_duration,
  si.missing,
  si.tag_scanned,
  si.storage_object_id,
  si.source_etag,
  so.physical_key,
  so.legacy_key,
  so.size AS object_size,
  so.etag AS object_etag
FROM roots r
JOIN storage_entries se ON se.path = r.root OR se.path LIKE r.root || '/%'
LEFT JOIN song_instances si ON si.id = se.instance_id
LEFT JOIN song_masters sm ON sm.id = si.master_id
LEFT JOIN albums al ON al.id = sm.album_id
LEFT JOIN storage_objects so ON so.id = COALESCE(se.object_id, si.storage_object_id)
ORDER BY r.root, se.path, se.kind, se.id;
