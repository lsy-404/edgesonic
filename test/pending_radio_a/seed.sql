INSERT INTO albums(id,name,song_count,duration,size) VALUES('pending-uploads','Pending Uploads',555,123211,21466454141),('al-86f72c214f','矩尺镜海·蚀刻于此媒介A',2,0,70560088);
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<549)
INSERT INTO song_masters(id,album_id,artist_id,title,duration) SELECT 'filler-'||x,'pending-uploads','unknown-artist','filler',222+CASE WHEN x<=193 THEN 1 ELSE 0 END FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<549)
INSERT INTO song_instances(id,master_id,source_id,source_type,suffix,size,duration,missing,tag_scanned,storage_object_id)
SELECT 'filler-si-'||x,'filler-'||x,'r2-local','original','wav',38734713+CASE WHEN x<=440 THEN 1 ELSE 0 END,222+CASE WHEN x<=193 THEN 1 ELSE 0 END,0,1,'filler-object' FROM n;
INSERT INTO song_masters(id,album_id,artist_id,title,track,duration) VALUES
 ('sm-5e95a72c01','al-86f72c214f','ar-bc386c9156','系统万象',3,150),
 ('sm-c1be4c1e30','al-86f72c214f','ar-bc386c9156','致邀请老用户',4,250);
CREATE TABLE fixture_source(master_id TEXT,instance_id TEXT,entry_id TEXT,object_id TEXT,title TEXT,duration INTEGER,size INTEGER,source_etag TEXT,object_etag TEXT,path TEXT,display_name TEXT,physical_key TEXT,track_no INTEGER);
INSERT INTO fixture_source VALUES
 ('sm-upload-9ec727e1-f07','si-upload-d86ded3f-22f','se-a57c76a38bd24db7a45ccb48e1fcfec0','obj_10b259d1d3a7dea8','01 矩尺镜海',188,33163244,'94290a0ce672197f0388ca32c8c806c3',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/01 矩尺镜海.wav','01 矩尺镜海.wav','objects/obj_10b259d1d3a7dea8.wav',1),
 ('sm-upload-26849242-9c3','si-upload-96bdf2c7-45f','se-88812cebeafc4107b76f7914097a96b2','obj_2bd85d12d528556f','02 信号心桥',150,26460044,'b966d71e92f459c3438effb8260e1843',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/02 信号心桥.wav','02 信号心桥.wav','objects/obj_2bd85d12d528556f.wav',2),
 ('sm-upload-0c44154f-289','si-upload-b4586662-c35','se-08f0fd9071f04205bc8f923168316337','obj_c8937ad566031d44','05 答案不唯一',186,32810444,'db0fc449658e65cd8bae798f5d7780d3','db0fc449658e65cd8bae798f5d7780d3','矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/05 答案不唯一.wav','05 答案不唯一.wav','objects/obj_c8937ad566031d44.wav',5),
 ('sm-upload-92016e7a-88a','si-upload-d6f052f6-2e0','se-a1080ee2bb884270b9a1fc04c7f70242','obj_633b150a9fa67eb1','06 Sublimity',186,32810444,'c56454c1fe6ccda1fe839afaa2bc10fd','c56454c1fe6ccda1fe839afaa2bc10fd','矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/06 Sublimity.wav','06 Sublimity.wav','objects/obj_633b150a9fa67eb1.wav',6),
 ('sm-upload-525717c0-4b4','si-upload-eb0e6ff6-435','se-71869db1edf44541a0b54f9aa6731fed','obj_aa95ef1f49802d94','07 月白非白 Bonus1',218,38455244,'dbbc277792550edf8df1053b74487aad',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/07 月白非白 Bonus1.wav','07 月白非白 Bonus1.wav','objects/obj_aa95ef1f49802d94.wav',7),
 ('sm-upload-39219943-6af','si-upload-e592df6c-53e','se-54297b62dc254408bdec1a02d2bf567b','obj_0ab8bd930fd67049','08 清澜若雪 Bonus2',212,37396844,'adfa216755144cfe1e77df22b398bd57',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/08 清澜若雪 Bonus2.wav','08 清澜若雪 Bonus2.wav','objects/obj_0ab8bd930fd67049.wav',8);
INSERT INTO song_masters(id,album_id,artist_id,title,duration) SELECT master_id,'pending-uploads','unknown-artist',title,duration FROM fixture_source;
INSERT INTO storage_objects(id,physical_key,suffix,size,etag) SELECT object_id,physical_key,'wav',size,object_etag FROM fixture_source;
INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag) SELECT instance_id,master_id,'r2-local','original','r2://'||physical_key,'wav',size,duration,0,1,object_id,source_etag FROM fixture_source;
INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id,instance_id) SELECT entry_id,'r2-local','se-698bb4fd7be549aaa70de23aa64ae9a1',path,display_name,'file',object_id,instance_id FROM fixture_source;
INSERT INTO storage_objects(id,physical_key,suffix,size,etag) VALUES
 ('obj_d44e216bb7f9ec91','objects/obj_d44e216bb7f9ec91.wav','wav',26460044,'f4010b7d206ec775c5218b046644c335'),
 ('obj_24e781dada6d780c','objects/obj_24e781dada6d780c.wav','wav',44100044,'6dd324452fd0648aacddd93ba6111b2d');
INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag) VALUES
 ('si-5e95a72c01','sm-5e95a72c01','r2-local','original','r2://objects/obj_d44e216bb7f9ec91.wav','wav',26460044,150,0,1,'obj_d44e216bb7f9ec91','f4010b7d206ec775c5218b046644c335'),
 ('si-c1be4c1e30','sm-c1be4c1e30','r2-local','original','r2://objects/obj_24e781dada6d780c.wav','wav',44100044,250,0,1,'obj_24e781dada6d780c','6dd324452fd0648aacddd93ba6111b2d');
INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id,instance_id) VALUES
 ('se-b6dc4b10c69844269b5c76c608a6d802','r2-local','se-698bb4fd7be549aaa70de23aa64ae9a1','矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/03 系统万象.wav','03 系统万象.wav','file','obj_d44e216bb7f9ec91','si-5e95a72c01'),
 ('se-611a9bfbdcad40228344b02cecbb9484','r2-local','se-698bb4fd7be549aaa70de23aa64ae9a1','矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介A/04 致邀请老用户.wav','04 致邀请老用户.wav','file','obj_24e781dada6d780c','si-c1be4c1e30');
