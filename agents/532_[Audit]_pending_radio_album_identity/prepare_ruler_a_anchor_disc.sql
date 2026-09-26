WITH a(master_id,title,artist_id,track_no,duration,instance_id,entry_id,path,object_id,physical_key,etag,size) AS (VALUES
 ('sm-5e95a72c01','系统万象','ar-bc386c9156',3,150,'si-5e95a72c01','se-b6dc4b10c69844269b5c76c608a6d802','矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/03 系统万象.wav','obj_d44e216bb7f9ec91','objects/obj_d44e216bb7f9ec91.wav','f4010b7d206ec775c5218b046644c335',26460044),
 ('sm-c1be4c1e30','致邀请老用户','ar-bc386c9156',4,250,'si-c1be4c1e30','se-611a9bfbdcad40228344b02cecbb9484','矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/04 致邀请老用户.wav','obj_24e781dada6d780c','objects/obj_24e781dada6d780c.wav','6dd324452fd0648aacddd93ba6111b2d',44100044)
), guard AS (
 SELECT CASE WHEN (SELECT COUNT(*) FROM a)=2
 AND (SELECT COUNT(*) FROM a c JOIN song_masters sm ON sm.id=c.master_id JOIN song_instances si ON si.id=c.instance_id AND si.master_id=sm.id JOIN storage_entries se ON se.id=c.entry_id AND se.instance_id=si.id JOIN storage_objects so ON so.id=c.object_id WHERE sm.album_id='al-86f72c214f' AND sm.artist_id=c.artist_id AND sm.album_artist_id IS NULL AND sm.title=c.title AND sm.track=c.track_no AND sm.disc IS NULL AND sm.duration=c.duration AND sm.lyrics IS NULL AND sm.lyrics_rich IS NULL AND sm.cover_r2_key IS NULL AND si.source_id='r2-local' AND si.source_type='original' AND si.storage_uri='r2://'||c.physical_key AND si.suffix='wav' AND si.size=c.size AND si.duration=c.duration AND si.missing=0 AND si.tag_scanned=1 AND si.storage_object_id=c.object_id AND si.source_etag=c.etag AND se.source_id='r2-local' AND se.parent_id='se-698bb4fd7be549aaa70de23aa64ae9a1' AND se.path=c.path AND se.display_name=substr(c.path,instr(c.path,'/矩尺镜海·蚀刻于此媒介A/')+length('/矩尺镜海·蚀刻于此媒介A/')) AND se.kind='file' AND se.object_id=c.object_id AND se.companion_of IS NULL AND so.physical_key=c.physical_key AND so.suffix='wav' AND so.size=c.size AND so.legacy_key IS NULL AND so.etag=c.etag)=2
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-86f72c214f')=8
 AND (SELECT COUNT(DISTINCT track) FROM song_masters WHERE album_id='al-86f72c214f' AND track BETWEEN 1 AND 8)=8
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-86f72c214f' AND track IN(1,2,5,6,7,8) AND disc=1)=6
 AND (SELECT COUNT(*) FROM albums WHERE id='al-86f72c214f' AND name='矩尺镜海·蚀刻于此媒介A' AND song_count=8 AND duration=1540 AND size=271656352)=1
 AND (SELECT COUNT(*) FROM albums WHERE id='pending-uploads' AND song_count=539 AND duration=120034 AND size=20877833365)=1
 THEN 1 ELSE 0 END ok
)
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'radio-a-disc-guard-failed','metadata','{}','guard_failed',unixepoch() FROM guard WHERE ok=0;
UPDATE song_masters SET disc=1,updated_at=unixepoch() WHERE id IN('sm-5e95a72c01','sm-c1be4c1e30') AND album_id='al-86f72c214f' AND disc IS NULL;
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'radio-a-disc-guard-failed','metadata','{}','guard_failed',unixepoch() WHERE changes()!=2;
