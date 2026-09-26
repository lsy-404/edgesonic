SELECT
  sm.id AS master_id, sm.album_id, sm.title, sm.artist_id, sm.album_artist_id,
  sm.track, sm.disc, sm.duration, sm.created_at, sm.updated_at,
  si.id AS instance_id, si.source_id, si.source_type, si.suffix, si.size,
  si.missing, si.tag_scanned, si.storage_object_id,
  so.id AS object_id, so.physical_key,
  se.id AS entry_id, se.parent_id, se.path, se.display_name, se.object_id AS entry_object_id,
  parent.display_name AS disc_folder, root.display_name AS release_folder,
  (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.song_master_id=sm.id) AS playlist_refs,
  (SELECT COUNT(*) FROM annotations a WHERE a.item_type='song' AND a.item_id=sm.id) AS annotation_refs,
  (SELECT COUNT(*) FROM song_artists sa WHERE sa.song_id=sm.id) AS song_artist_refs,
  (SELECT COUNT(*) FROM storage_entries child WHERE child.parent_id=se.id) AS entry_child_refs
FROM song_masters sm
JOIN song_instances si ON si.master_id=sm.id
JOIN storage_objects so ON so.id=si.storage_object_id
JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file'
LEFT JOIN storage_entries parent ON parent.id=se.parent_id
LEFT JOIN storage_entries root ON root.id=parent.parent_id
WHERE sm.album_id='pending-uploads'
  AND se.source_id='r2-local'
  AND se.path LIKE 'Find-Zero/%'
ORDER BY se.path;

SELECT
  a.id AS album_id, a.name, a.year, a.genre, a.compilation, a.song_count, a.duration, a.size,
  a.created_at, a.updated_at,
  (SELECT COUNT(*) FROM annotations n WHERE n.item_type='album' AND n.item_id=a.id) AS annotation_refs,
  (SELECT COUNT(*) FROM album_display_group_members gm WHERE gm.album_id=a.id) AS display_group_refs
FROM albums a
WHERE a.name='Find-Zero'
ORDER BY a.id;

SELECT sm.id AS master_id, sm.album_id, sm.title, sm.track, sm.disc, sm.duration,
  si.id AS instance_id, si.suffix, si.size, si.storage_object_id, so.physical_key
FROM song_masters sm
JOIN song_instances si ON si.master_id=sm.id
JOIN storage_objects so ON so.id=si.storage_object_id
WHERE sm.album_id IN (SELECT id FROM albums WHERE name='Find-Zero')
ORDER BY sm.album_id, COALESCE(sm.disc,0), COALESCE(sm.track,0), sm.id;

SELECT se.id, se.parent_id, se.path, se.display_name, se.kind, se.instance_id, se.object_id, se.companion_of
FROM storage_entries se
WHERE se.path LIKE 'Find-Zero/%'
ORDER BY se.path;
