SELECT sm.id AS master_id,sm.album_id,sm.disc,sm.track,sm.duration,si.id AS instance_id,si.storage_object_id,si.source_id,si.source_type,si.suffix,si.size AS instance_size,si.missing,si.tag_scanned,se.id AS entry_id,se.path,se.display_name,so.physical_key,so.size AS object_size
FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id JOIN storage_entries se ON se.instance_id=si.id AND se.kind='file' JOIN storage_objects so ON so.id=si.storage_object_id
WHERE instr(se.path,'你的灵魂长出一支玫瑰（人声版）')>0 ORDER BY se.path;

SELECT song_count,duration,size FROM albums WHERE id='pending-uploads';
