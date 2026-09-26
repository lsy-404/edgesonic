WITH roots(root) AS (VALUES
  ('幸福三部曲 - VOICEMITH/CD_mastered_CN'),
  ('蔗蓝的创作集1.0-蔗蓝（wav）'),
  ('夜幻寻梦    夢ノ結唱'),
  ('依路相随 CD/wav')
)
SELECT r.root,
  json_group_array(json_object(
    'path', se.path, 'kind', se.kind, 'entry', se.id, 'parent', se.parent_id,
    'master', sm.id, 'album', sm.album_id, 'artist', sm.artist_id, 'album_artist', sm.album_artist_id,
    'title', sm.title, 'track', sm.track, 'disc', sm.disc, 'duration', si.duration,
    'suffix', si.suffix, 'size', si.size, 'missing', si.missing, 'tag_scanned', si.tag_scanned,
    'instance', si.id, 'object', so.id, 'physical_key', so.physical_key,
    'source_etag', si.source_etag, 'companion_of', se.companion_of
  )) AS entries
FROM roots r
JOIN storage_entries se ON se.path = r.root OR se.path LIKE r.root || '/%'
LEFT JOIN song_instances si ON si.id = se.instance_id
LEFT JOIN song_masters sm ON sm.id = si.master_id
LEFT JOIN storage_objects so ON so.id = COALESCE(se.object_id,si.storage_object_id)
GROUP BY r.root
ORDER BY r.root;

SELECT a.id AS album_id, a.name, a.song_count, sm.id AS master_id, sm.title, sm.track, sm.disc,
  si.id AS instance_id, si.suffix, si.size, si.duration, si.missing, si.tag_scanned,
  se.path, se.id AS entry_id, so.id AS object_id, so.physical_key
FROM albums a
JOIN song_masters sm ON sm.album_id = a.id
LEFT JOIN song_instances si ON si.master_id = sm.id AND si.source_type = 'original'
LEFT JOIN storage_entries se ON se.instance_id = si.id AND se.kind = 'file'
LEFT JOIN storage_objects so ON so.id = si.storage_object_id
WHERE a.name = '夜幻寻梦_Midnight Revereies-α'
ORDER BY a.id, sm.title, si.id;
