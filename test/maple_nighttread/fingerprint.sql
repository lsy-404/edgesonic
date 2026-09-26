SELECT 'albums' AS section,group_concat(id||':'||name||':'||song_count||':'||duration||':'||size||':'||COALESCE(cover_r2_key,''),'|') AS fingerprint FROM (SELECT * FROM albums ORDER BY id);
SELECT 'masters' AS section,group_concat(id||':'||album_id||':'||title||':'||COALESCE(track,-1)||':'||COALESCE(disc,-1)||':'||COALESCE(duration,-1),'|') AS fingerprint FROM (SELECT * FROM song_masters ORDER BY id);
SELECT 'instances' AS section,group_concat(id||':'||master_id||':'||COALESCE(storage_object_id,'')||':'||COALESCE(storage_uri,'')||':'||COALESCE(suffix,'')||':'||COALESCE(size,-1),'|') AS fingerprint FROM (SELECT * FROM song_instances ORDER BY id);
SELECT 'objects' AS section,group_concat(id||':'||physical_key||':'||size,'|') AS fingerprint FROM (SELECT * FROM storage_objects ORDER BY id);
SELECT 'entries' AS section,group_concat(id||':'||path||':'||display_name||':'||object_id||':'||instance_id||':'||COALESCE(companion_of,''),'|') AS fingerprint FROM (SELECT * FROM storage_entries ORDER BY id);
SELECT 'groups' AS section,group_concat(id||':'||display_name,'|') AS fingerprint FROM (SELECT * FROM album_display_groups ORDER BY id);
SELECT 'members' AS section,group_concat(group_id||':'||album_id||':'||sort_order,'|') AS fingerprint FROM (SELECT * FROM album_display_group_members ORDER BY group_id,album_id);
