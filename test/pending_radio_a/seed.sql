INSERT INTO albums(id,name,song_count,duration,size) VALUES('pending-uploads','Pending Uploads',539,120034,20877833365),('al-86f72c214f','矩尺镜海·蚀刻于此媒介A',8,1540,271656352);
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<523)
INSERT INTO song_masters(id,album_id,artist_id,title,duration) SELECT 'filler-'||x,'pending-uploads','unknown-artist','filler',223+CASE WHEN x<=175 THEN 1 ELSE 0 END FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<523)
INSERT INTO song_instances(id,master_id,source_id,source_type,suffix,size,duration,missing,tag_scanned,storage_object_id)
SELECT 'filler-si-'||x,'filler-'||x,'r2-local','original','wav',38829943+CASE WHEN x<=472 THEN 1 ELSE 0 END,223+CASE WHEN x<=175 THEN 1 ELSE 0 END,0,1,'filler-object' FROM n;
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
INSERT INTO song_masters(id,album_id,artist_id,title,track,disc,duration) SELECT master_id,'al-86f72c214f','unknown-artist',title,track_no,1,duration FROM fixture_source;
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

CREATE TABLE fixture_b(master_id TEXT,instance_id TEXT,entry_id TEXT,object_id TEXT,title TEXT,duration INTEGER,size INTEGER,source_etag TEXT,object_etag TEXT,path TEXT,display_name TEXT,physical_key TEXT);
INSERT INTO fixture_b VALUES
 ('sm-upload-2951ebf2-1c9','si-upload-4b3dc01a-947','se-1a99ef79b4d2426a8b555c4d6df8ac3b','obj_4d00753c5c53a7b6','01 清澜若雪-Narrator Version-',220,38808044,'a7e0113949a5a5b7c1211371bd23121b',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/01 清澜若雪-Narrator Version-.wav','01 清澜若雪-Narrator Version-.wav','objects/obj_4d00753c5c53a7b6.wav'),
 ('sm-upload-6d92e829-e2e','si-upload-1a5c8ef7-e48','se-361e994757f14865bf32cac2871b45e7','obj_ee9054082224691f','02 信号心桥',154,27165644,'114f86ab9575ff9c8609d343adb7a43a',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/02 信号心桥.wav','02 信号心桥.wav','objects/obj_ee9054082224691f.wav'),
 ('sm-upload-1cc8aa27-9dc','si-upload-c42f8371-c30','se-2b8885c7fa9749cd915f28653683f2ab','obj_c918a16e23d354a4','03 深秋之霜',238,41983244,'f9e788c3d493ebdeb108f140b224067b',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/03 深秋之霜.wav','03 深秋之霜.wav','objects/obj_c918a16e23d354a4.wav'),
 ('sm-upload-67c07f86-3f8','si-upload-0c3633a1-0a0','se-9e2e0a7aa8e8450c8e98bb729bdf98a7','obj_3c69530abad7731f','04 卡珊德拉症候群',284,50097644,'5f8e9931db10ed52d80c72e2d5ffdbee',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/04 卡珊德拉症候群.wav','04 卡珊德拉症候群.wav','objects/obj_3c69530abad7731f.wav'),
 ('sm-upload-2fd6c848-5ba','si-upload-11991841-0bc','se-2ca3a2ecfb8d4c7aba2f0fe46f0d616a','obj_2fa736ac6e7951af','05 Sublimity',184,32457644,'ab0859412b1ba88e20641baac3d5c045',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/05 Sublimity.wav','05 Sublimity.wav','objects/obj_2fa736ac6e7951af.wav'),
 ('sm-upload-75a80b93-ab3','si-upload-a4ceb0f1-d55','se-2ed560b4c0aa4d06af1917dc764802e4','obj_2ea4bd2e3a897d3a','06 答案不唯一',192,33868844,'f41a1f802dab94e2c14a34d873dbd044',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/06 答案不唯一.wav','06 答案不唯一.wav','objects/obj_2ea4bd2e3a897d3a.wav'),
 ('sm-upload-d1f9252b-84f','si-upload-92a99688-2ea','se-d139cbcb73ab4fb183a835b3f81b0b4f','obj_3ae0c605680344d6','07  答案不唯一-Mobile Version-',192,33868844,'a51fb7f8cda6b2415fe8d7879d29a2e7',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/07  答案不唯一-Mobile Version-.wav','07  答案不唯一-Mobile Version-.wav','objects/obj_3ae0c605680344d6.wav'),
 ('sm-upload-90dda889-de5','si-upload-b6efdf4d-9be','se-7be566a940a6427f9bc6d99d1563ecd2','obj_cd55a6f2c8273020','08  Cassandra',80,14112044,'f21cc4607acc8ba245fa102cb9dab2a5',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/08  Cassandra.wav','08  Cassandra.wav','objects/obj_cd55a6f2c8273020.wav'),
 ('sm-upload-744f6b02-73d','si-upload-68c9875e-d17','se-3fc64dea60414145bd9eaaee88132411','obj_b67525dbf0f3296c','09 进化算法',314,55389644,'767cab924f3bc77ebec7ce58ec9ec6bd',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/09 进化算法.wav','09 进化算法.wav','objects/obj_b67525dbf0f3296c.wav'),
 ('sm-upload-49ee7714-3f3','si-upload-ab1f5cf0-52b','se-1433f97ed8564d14b50c00847d3f0b67','obj_8ea39fc37e155821','10 致邀请老用户',254,44805644,'810c70f761cdb9aeb556e2dab5c92307',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/10 致邀请老用户.wav','10 致邀请老用户.wav','objects/obj_8ea39fc37e155821.wav'),
 ('sm-upload-07b8aecc-f33','si-upload-3966a143-b1c','se-0c647400b53a4aac86d255c9e4983eb8','obj_ae6caa51c34bbebf','11 献给黑色圣母的檄文',150,26460044,'ea6ff5a357ebb2b556ba125e2a50bf30',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/11 献给黑色圣母的檄文.wav','11 献给黑色圣母的檄文.wav','objects/obj_ae6caa51c34bbebf.wav'),
 ('sm-upload-185bd48c-77e','si-upload-01e95792-8c5','se-aae34bcd32074bf7bbaf1481dc7a894f','obj_ae416c4f0261a7a7','12  月白非白',216,38102444,'1df01895672a32c53bf6c67de3052fcd',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/12  月白非白.wav','12  月白非白.wav','objects/obj_ae416c4f0261a7a7.wav'),
 ('sm-upload-a02fe32f-3d6','si-upload-ce08a8f8-b4e','se-31e3f791bac74edbb35e79a300f36da1','obj_cb9876787785bcdf','13 处决一束白月光',174,30693644,'aa99b916e8484718c59534eb7ae0c205',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/13 处决一束白月光.wav','13 处决一束白月光.wav','objects/obj_cb9876787785bcdf.wav'),
 ('sm-upload-696becc9-1c2','si-upload-bdcd8bb2-cae','se-6164ede483f442a79059587bf92b92e5','obj_7938b01e83ead09e','14 沉没海妖之礁',154,27165644,'a51ada06cda3c7dd662a15beaa39cc40',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/14 沉没海妖之礁.wav','14 沉没海妖之礁.wav','objects/obj_7938b01e83ead09e.wav'),
 ('sm-upload-3b9e63ad-845','si-upload-c36c6e81-bf6','se-7d1c5bbfc45d4858ae4cf42be1e9bb13','obj_ef075b33a8e3bb60','15 刀风刃雨',274,48333644,'ea92d771855aa7218f18d0a241cd7aee',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/15 刀风刃雨.wav','15 刀风刃雨.wav','objects/obj_ef075b33a8e3bb60.wav'),
 ('sm-upload-2ba61d46-fe7','si-upload-eee60080-e96','se-c6db15fb3d4b49c689877dca4cc98d34','obj_dadeab80e6ac9a80','16 系统万象',150,26460044,'c2322dc2cf08496e6386e8b100710462',NULL,'矩尺镜海·蚀刻于此媒介/矩尺镜海·蚀刻于此媒介B/16 系统万象.wav','16 系统万象.wav','objects/obj_dadeab80e6ac9a80.wav');
INSERT INTO song_masters(id,album_id,artist_id,title,duration) SELECT master_id,'pending-uploads','unknown-artist',title,duration FROM fixture_b;
INSERT INTO storage_objects(id,physical_key,suffix,size,etag) SELECT object_id,physical_key,'wav',size,object_etag FROM fixture_b;
INSERT INTO song_instances(id,master_id,source_id,source_type,storage_uri,suffix,size,duration,missing,tag_scanned,storage_object_id,source_etag) SELECT instance_id,master_id,'r2-local','original','r2://'||physical_key,'wav',size,duration,0,1,object_id,source_etag FROM fixture_b;
INSERT INTO storage_entries(id,source_id,parent_id,path,display_name,kind,object_id,instance_id) SELECT entry_id,'r2-local','se-cc9368c480864e68b672b159b2215a01',path,display_name,'file',object_id,instance_id FROM fixture_b;
