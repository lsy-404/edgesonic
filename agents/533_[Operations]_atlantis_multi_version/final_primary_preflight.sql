SELECT sm.id AS master_id,sm.album_id,sm.track,sm.disc,sm.duration,sm.artist_id,sm.album_artist_id,sm.genre,sm.compilation,si.id AS instance_id,si.source_id,si.source_type,si.suffix,si.bit_rate,si.sample_rate,si.bit_depth,si.channels,si.size,si.missing,si.tag_scanned,si.storage_object_id AS object_id,so.physical_key,so.size AS object_size,se.id AS entry_id,se.kind,se.parent_id,se.object_id AS entry_object_id,sm.title,sm.participants,sm.lyrics,sm.lyrics_rich,se.path,se.display_name
FROM song_masters sm
JOIN song_instances si ON si.master_id=sm.id
LEFT JOIN storage_objects so ON so.id=si.storage_object_id
LEFT JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file'
WHERE sm.album_id='al-eddee4ba83'
ORDER BY sm.track,sm.title,si.suffix,si.id;
