-- D1-only candidate. Preserve all WAV instances, objects, and entries.
WITH expected(master_id, instance_id, object_id, entry_id, entry_path, disc_number, track_number, physical_key) AS (VALUES
('sm-upload-df5cc0c1-3ef','si-upload-af5727fb-7c8','obj_47cdec93c968fabf','se-8b488dcd38304e3d87b1cdd9c2d1f50c','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE A/01 绮年相遇.wav',1,1,'objects/obj_47cdec93c968fabf.wav'),
('sm-upload-1080544a-877','si-upload-801ef764-079','obj_d13e864f286cdc06','se-48cc503856c34b0a965685203e945a98','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE A/02 向蔷薇般的少女献上礼赞.wav',1,2,'objects/obj_d13e864f286cdc06.wav'),
('sm-upload-454e3969-759','si-upload-21532440-25c','obj_083a052117b051ab','se-3b36d1d7e74944068831ed428b409e2b','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE A/03 流金愿.wav',1,3,'objects/obj_083a052117b051ab.wav'),
('sm-upload-90d95e2a-c8a','si-upload-0826fa5d-41d','obj_b0e6deaf82c2c79e','se-e7402961b27a4c0fb531e3c09d7d3377','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE A/04 在下，言和.wav',1,4,'objects/obj_b0e6deaf82c2c79e.wav'),
('sm-upload-e9b2aec7-ee7','si-upload-b16f065d-340','obj_fb5519617f32d322','se-a82f9f26977a482782bc443534a18e1a','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE A/05 未命名星探索日志.wav',1,5,'objects/obj_fb5519617f32d322.wav'),
('sm-upload-dbd3cc07-233','si-upload-b903b2a9-3d5','obj_da06bfe7aad6b1af','se-de4414666fbd454cb8373c7d8f8f6b2a','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/01 蛇蜕.wav',2,1,'objects/obj_da06bfe7aad6b1af.wav'),
('sm-upload-7b326b4b-085','si-upload-51096b93-617','obj_f1ba3d6f635a8f2e','se-c16e3f6715174377a95da9927c18eb06','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/02 末日电台FM.1999.wav',2,2,'objects/obj_f1ba3d6f635a8f2e.wav'),
('sm-upload-b22b9e75-f53','si-upload-1863dbc9-c86','obj_7adba36df5df4889','se-9f2aa9ee6d084642ac583028bf772f64','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/03 闪潮.wav',2,3,'objects/obj_7adba36df5df4889.wav'),
('sm-upload-03ba3756-948','si-upload-804373f8-d68','obj_54e67439ff76ef09','se-92119881a37547b98ce9d8983b0eba6e','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/04 My Symbiotic Eden.wav',2,4,'objects/obj_54e67439ff76ef09.wav'),
('sm-upload-e1d6c61e-572','si-upload-f58a6efa-240','obj_eb6760050bb8cc0e','se-3f13007210104968839f257196ce483c','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/05 鲛绡歌.wav',2,5,'objects/obj_eb6760050bb8cc0e.wav'),
('sm-upload-d5093ff4-b5e','si-upload-a116475d-f3e','obj_a9cdb950e53996b1','se-03308904a1554110ad32ee06c3d657b4','夏日应时而至 (彩胶板)/夏日应时而至-彩胶版/SIDE B/06 若你终将独自前行.wav',2,6,'objects/obj_a9cdb950e53996b1.wav')
), valid_source AS (
 SELECT e.master_id FROM expected e JOIN song_masters sm ON sm.id=e.master_id AND sm.album_id='pending-uploads' AND sm.track IS NULL AND sm.disc IS NULL
 JOIN song_instances si ON si.id=e.instance_id AND si.master_id=sm.id AND si.storage_object_id=e.object_id AND si.storage_uri='r2://'||e.physical_key AND si.missing=0
 JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=si.id AND se.object_id=e.object_id AND se.path=e.entry_path
 JOIN storage_objects so ON so.id=e.object_id AND so.physical_key=e.physical_key
)
SELECT count(*) n FROM valid_source;