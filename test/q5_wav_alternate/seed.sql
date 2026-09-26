INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at) VALUES
 ('pending-uploads','Pending Uploads','pending uploads',NULL,NULL,NULL,523,116804,20308060661,0,1,1),
 ('al-ac89e8964d','平行四界Quadimension 5','平行四界quadimension 5',2016,NULL,'covers/al-ac89e8964d',10,2691,457556360,0,1,1);
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<522)
INSERT INTO song_masters(id,album_id,artist_id,title,track,disc,duration)
SELECT 'filler-'||x,'pending-uploads','unknown-artist','filler',NULL,NULL,223+CASE WHEN x<=139 THEN 1 ELSE 0 END FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<522)
INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag)
SELECT 'filler-si-'||x,'filler-'||x,'r2-local','original','r2://filler/'||x,'wav',38816937+CASE WHEN x<=111 THEN 1 ELSE 0 END,223+CASE WHEN x<=139 THEN 1 ELSE 0 END,0,1,'filler-object-'||x,'filler-etag-'||x FROM n;
INSERT INTO song_masters(id,album_id,artist_id,album_artist_id,title,track,disc,duration) VALUES
 ('486','al-ac89e8964d','ar-2b4aeae2d9','ar-b86d3071fc','最后的歌',10,1,259),
 ('sm-upload-1c5e734b-599','pending-uploads','unknown-artist',NULL,'10  -最后的歌',NULL,NULL,259);
INSERT INTO storage_objects(id,physical_key,suffix,content_type,size,legacy_key,etag) VALUES
 ('obj_10700e8c4872ea79','objects/obj_10700e8c4872ea79.flac','flac',NULL,23568474,NULL,'7ee74890fe63fbf3ca83539aa70bc9b6'),
 ('obj_790adcf9317cb20f','objects/obj_790adcf9317cb20f.wav','wav','audio/wav',45619436,NULL,'4712159da2cb9e921adf03fe6016734c');
INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag) VALUES
 ('si-mirror-ed8ee36e679948c4','486','r2-local','original','r2://objects/obj_10700e8c4872ea79.flac','flac',23568474,259,0,1,'obj_10700e8c4872ea79','7ee74890fe63fbf3ca83539aa70bc9b6'),
 ('si-upload-1fe48367-3ca','sm-upload-1c5e734b-599','r2-local','original','r2://objects/obj_790adcf9317cb20f.wav','wav',45619436,259,0,1,'obj_790adcf9317cb20f','4712159da2cb9e921adf03fe6016734c');
INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id,instance_id,companion_of) VALUES
 ('se-7f3f6ce64a5e4a94ad5db0ff76e74bad','r2-local','se-af38e2f70e2f4bc08b642e8d310370dc','平行四界Quadimension 5/10 - 最后的歌.flac','10 - 最后的歌.flac','file','obj_10700e8c4872ea79','si-mirror-ed8ee36e679948c4',NULL),
 ('se-a15a32d5a9004fb1bef0b8853b1c290d','r2-local','se-a1fc619bab3a4b249497ab6c3a8057f1','平四1-6/平行四界5/10  -最后的歌.wav','10  -最后的歌.wav','file','obj_790adcf9317cb20f','si-upload-1fe48367-3ca',NULL);
