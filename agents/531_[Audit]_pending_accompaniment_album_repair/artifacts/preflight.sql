SELECT sm.id,sm.album_id,sm.disc,sm.track,si.id AS instance_id,si.missing,si.tag_scanned,se.path,so.physical_key,so.size
FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' JOIN storage_objects so ON so.id=si.storage_object_id
WHERE se.path LIKE '众虫皆歌/伴奏/%' ORDER BY se.path;
