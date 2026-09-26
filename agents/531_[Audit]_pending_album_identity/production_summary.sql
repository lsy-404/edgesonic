WITH roots(root) AS (VALUES
  ('幸福三部曲 - VOICEMITH/CD_mastered_CN'),
  ('蔗蓝的创作集1.0-蔗蓝（wav）'),
  ('夜幻寻梦    夢ノ結唱'),
  ('依路相随 CD/wav')
), tree AS (
  SELECT r.root, se.*, si.id AS si_id, si.master_id, si.suffix, si.missing, si.tag_scanned,
    si.storage_object_id, si.size AS instance_size, si.duration AS instance_duration,
    sm.album_id, sm.title, sm.track, sm.disc, sm.lyrics, sm.lyrics_rich, sm.cover_r2_key
  FROM roots r JOIN storage_entries se ON se.path = r.root OR se.path LIKE r.root || '/%'
  LEFT JOIN song_instances si ON si.id = se.instance_id
  LEFT JOIN song_masters sm ON sm.id = si.master_id
)
SELECT root,
  COUNT(*) AS tree_entries,
  SUM(kind = 'folder') AS folders,
  SUM(kind = 'file') AS files,
  SUM(si_id IS NOT NULL) AS instances,
  SUM(si_id IS NOT NULL AND lower(suffix) = 'wav') AS wav_instances,
  SUM(si_id IS NOT NULL AND lower(suffix) NOT IN ('wav')) AS other_audio_instances,
  SUM(kind = 'file' AND si_id IS NULL) AS sidecars,
  SUM(CASE WHEN missing = 0 THEN 1 ELSE 0 END) AS present_instances,
  SUM(CASE WHEN tag_scanned = 1 THEN 1 ELSE 0 END) AS scanned_instances,
  COUNT(DISTINCT album_id) AS current_album_count,
  GROUP_CONCAT(DISTINCT album_id) AS current_album_ids,
  SUM(CASE WHEN lyrics IS NOT NULL THEN 1 ELSE 0 END) AS lyric_masters,
  SUM(CASE WHEN lyrics_rich IS NOT NULL THEN 1 ELSE 0 END) AS rich_lyric_masters,
  SUM(CASE WHEN cover_r2_key IS NOT NULL THEN 1 ELSE 0 END) AS cover_linked_masters,
  SUM(CASE WHEN companion_of IS NOT NULL THEN 1 ELSE 0 END) AS companion_entries,
  SUM(CASE WHEN track IS NOT NULL OR disc IS NOT NULL THEN 1 ELSE 0 END) AS already_ordered,
  MIN(path) AS first_path,
  MAX(path) AS last_path
FROM tree
GROUP BY root
ORDER BY root;

SELECT a.id, a.name, a.song_count, a.duration, a.size, a.cover_r2_key
FROM albums a
WHERE lower(a.name) IN (
  lower('幸福三部曲 - VOICEMITH'), lower('蔗蓝的创作集1.0'), lower('夜幻寻梦'), lower('依路相随')
) OR lower(a.name) LIKE '%幸福三部曲%' OR lower(a.name) LIKE '%蔗蓝%' OR lower(a.name) LIKE '%夜幻寻梦%' OR lower(a.name) LIKE '%依路相随%'
ORDER BY a.name, a.id;
