-- Local rehearsal candidate only. It preserves every entry, object, instance, and sidecar.
WITH c(master_id) AS (VALUES
 ('sm-upload-1f9017ea-07f'),('sm-upload-e736c93d-965'),('sm-upload-e28f7e1d-766'),('sm-upload-a6848b06-77d'),
 ('sm-upload-dd6123b1-898'),('sm-upload-02e005e7-c69'),('sm-upload-00211c6c-9ec'),('sm-upload-ad051eb3-7a3'),
 ('sm-upload-6994d270-a67'),('sm-upload-1f16389e-357'),('sm-upload-048a0756-d80'),('sm-upload-67927a7e-561'),
 ('sm-upload-23a540dc-0e6'),('sm-upload-625aa43b-4d2'),('sm-upload-72a666eb-1fa'),('sm-upload-c289a81c-56a'),
 ('sm-upload-2646aee8-8c7'),('sm-upload-6459b53d-e6e'),('sm-upload-d2e15dcf-ef7'),('sm-upload-72dbb920-90d'),
 ('sm-upload-29aa737e-d7d'),('sm-upload-82fdd9cb-3dc'),('sm-upload-1a1b38e3-18e'),('sm-upload-0534d6fb-3e6'),
 ('sm-upload-3511d1fa-551'),('sm-upload-f22fe5c6-23b'),('sm-upload-ad9a3f3a-778'),('sm-upload-ccea0ae3-484')
)
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'zhulan-guard-failed','metadata','{}','guard_failed',unixepoch()
WHERE NOT (
  (SELECT COUNT(*) FROM c)=28
  AND (SELECT COUNT(*) FROM song_masters sm JOIN c ON c.master_id=sm.id WHERE sm.album_id='pending-uploads' AND sm.artist_id='unknown-artist' AND sm.track IS NULL AND sm.disc IS NULL)=28
  AND (SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN c ON c.master_id=si.master_id JOIN storage_objects so ON so.id=si.storage_object_id
       WHERE se.kind='file' AND se.parent_id='se-e43af23755444b1aa56d4501c7ba77d4' AND se.path LIKE '蔗蓝的创作集1.0-蔗蓝（wav）/%' AND si.source_id='r2-local' AND si.source_type='original' AND si.missing=0 AND si.tag_scanned=1 AND lower(si.suffix)='wav')=28
  AND (SELECT COUNT(*) FROM storage_entries WHERE path='蔗蓝的创作集1.0-蔗蓝（wav）' OR path LIKE '蔗蓝的创作集1.0-蔗蓝（wav）/%')=30
  AND EXISTS(SELECT 1 FROM storage_entries WHERE id='se-9c7a6e8fe38949a6b6a231dafc7ccad1' AND object_id='obj_568cc33144589d95' AND path='蔗蓝的创作集1.0-蔗蓝（wav）/蔗蓝的创作集1.0.cue')
  AND EXISTS(SELECT 1 FROM albums WHERE id='pending-uploads' AND song_count=641 AND duration=141395 AND size=24700222725)
  AND NOT EXISTS(SELECT 1 FROM artists WHERE id='ar-abdf58605e' OR name='蔗蓝')
  AND NOT EXISTS(SELECT 1 FROM albums WHERE id='al-fe198b18b1' OR name='蔗蓝的创作集1.0')
);
INSERT INTO artists(id,name,sort_name,created_at,updated_at) VALUES('ar-abdf58605e','蔗蓝','蔗蓝',unixepoch(),unixepoch());
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'zhulan-guard-failed','metadata','{}','guard_failed',unixepoch() WHERE changes()!=1;
INSERT INTO albums(id,name,sort_name,song_count,duration,size,compilation,created_at,updated_at) VALUES('al-fe198b18b1','蔗蓝的创作集1.0','蔗蓝的创作集1.0',0,0,0,0,unixepoch(),unixepoch());
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'zhulan-guard-failed','metadata','{}','guard_failed',unixepoch() WHERE changes()!=1;
WITH c(master_id) AS (VALUES
 ('sm-upload-1f9017ea-07f'),('sm-upload-e736c93d-965'),('sm-upload-e28f7e1d-766'),('sm-upload-a6848b06-77d'),('sm-upload-dd6123b1-898'),('sm-upload-02e005e7-c69'),('sm-upload-00211c6c-9ec'),('sm-upload-ad051eb3-7a3'),('sm-upload-6994d270-a67'),('sm-upload-1f16389e-357'),('sm-upload-048a0756-d80'),('sm-upload-67927a7e-561'),('sm-upload-23a540dc-0e6'),('sm-upload-625aa43b-4d2'),('sm-upload-72a666eb-1fa'),('sm-upload-c289a81c-56a'),('sm-upload-2646aee8-8c7'),('sm-upload-6459b53d-e6e'),('sm-upload-d2e15dcf-ef7'),('sm-upload-72dbb920-90d'),('sm-upload-29aa737e-d7d'),('sm-upload-82fdd9cb-3dc'),('sm-upload-1a1b38e3-18e'),('sm-upload-0534d6fb-3e6'),('sm-upload-3511d1fa-551'),('sm-upload-f22fe5c6-23b'),('sm-upload-ad9a3f3a-778'),('sm-upload-ccea0ae3-484'))
UPDATE song_masters SET album_id='al-fe198b18b1',artist_id='ar-abdf58605e',album_artist_id='ar-abdf58605e',track=CAST(substr(title,1,2) AS INTEGER),disc=1,updated_at=unixepoch() WHERE id IN(SELECT master_id FROM c) AND album_id='pending-uploads' AND artist_id='unknown-artist' AND track IS NULL AND disc IS NULL;
INSERT INTO work_queue(id,task_type,payload,status,created_at) SELECT 'zhulan-guard-failed','metadata','{}','guard_failed',unixepoch() WHERE changes()!=28;
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id IN('pending-uploads','al-fe198b18b1');
-- A local rehearsal may insert this marker before the file to prove atomic late rollback.
INSERT INTO work_queue(id,task_type,payload,status,created_at)
SELECT 'zhulan-guard-failed','metadata','{}','guard_failed',unixepoch()
WHERE EXISTS(SELECT 1 FROM work_queue WHERE id='zhulan-force-late-failure');
