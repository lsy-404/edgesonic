SELECT
  sm.id AS master_id,
  sm.album_id,
  sm.artist_id,
  sm.album_artist_id,
  sm.title,
  sm.track,
  sm.disc,
  sm.duration AS master_duration,
  sm.lyrics IS NOT NULL AS has_lyrics,
  sm.lyrics_rich IS NOT NULL AS has_rich_lyrics,
  sm.cover_r2_key,
  si.id AS instance_id,
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
  se.id AS entry_id,
  se.source_id AS entry_source_id,
  se.parent_id,
  se.path,
  se.display_name,
  se.kind,
  se.object_id,
  se.companion_of,
  so.physical_key,
  so.legacy_key,
  so.size AS object_size,
  so.etag AS object_etag,
  so.suffix AS object_suffix
FROM song_masters sm
JOIN song_instances si ON si.master_id = sm.id
JOIN storage_entries se ON se.instance_id = si.id
JOIN storage_objects so ON so.id = si.storage_object_id
WHERE sm.id IN (
  'sm-upload-9ec727e1-f07',
  'sm-upload-26849242-9c3',
  'sm-upload-0c44154f-289',
  'sm-upload-92016e7a-88a',
  'sm-upload-525717c0-4b4',
  'sm-upload-39219943-6af'
)
ORDER BY se.path;

SELECT id, name, song_count, duration, size
FROM albums
WHERE id IN ('pending-uploads', 'al-86f72c214f')
ORDER BY id;
