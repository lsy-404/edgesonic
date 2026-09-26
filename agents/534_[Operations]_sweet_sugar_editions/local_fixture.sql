
PRAGMA foreign_keys=ON;
CREATE TABLE albums(
  id TEXT PRIMARY KEY,name TEXT,sort_name TEXT,year INTEGER,genre TEXT,
  cover_r2_key TEXT,song_count INTEGER,duration INTEGER,size INTEGER,
  compilation INTEGER,created_at INTEGER,updated_at INTEGER
);
CREATE TABLE song_masters(
  id TEXT PRIMARY KEY,album_id TEXT REFERENCES albums(id),artist_id TEXT,
  album_artist_id TEXT,title TEXT,sort_title TEXT,disc INTEGER,track INTEGER,
  duration INTEGER,genre TEXT,updated_at INTEGER
);
CREATE TABLE song_instances(
  id TEXT PRIMARY KEY,master_id TEXT REFERENCES song_masters(id),source_id TEXT,
  source_type TEXT,storage_uri TEXT,storage_object_id TEXT,suffix TEXT,
  size INTEGER,missing INTEGER,tag_scanned INTEGER
);
CREATE TABLE storage_objects(id TEXT PRIMARY KEY,physical_key TEXT,size INTEGER);
CREATE TABLE storage_entries(
  id TEXT PRIMARY KEY,source_id TEXT,parent_id TEXT,path TEXT,kind TEXT,
  instance_id TEXT REFERENCES song_instances(id),object_id TEXT REFERENCES storage_objects(id)
);
CREATE TABLE album_display_groups(
  id TEXT PRIMARY KEY,display_name TEXT,sort_name TEXT,created_at INTEGER,updated_at INTEGER
);
CREATE TABLE album_display_group_members(
  group_id TEXT REFERENCES album_display_groups(id),album_id TEXT REFERENCES albums(id),
  sort_order INTEGER,PRIMARY KEY(group_id,album_id)
);
CREATE TABLE work_queue(id TEXT PRIMARY KEY,status TEXT,payload TEXT);

INSERT INTO albums VALUES('al-1aee8da1c9','Sweet Sugar','sweet sugar',NULL,NULL,'covers/al-1aee8da1c9',23,5513,410713535,1,1790317169,1790394247);
INSERT INTO song_masters VALUES('sm-upload-dc465b39-837','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'紙飛行機','紙飛行機',NULL,2,199,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-40be3f1b-142','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'わがまま','わがまま',NULL,3,289,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-084a7de8-7a9','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Iyaiya','iyaiya',NULL,4,203,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-845cba64-1aa','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Starline','starline',NULL,5,275,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-1c4463de-34c','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Sweet Sugar','sweet sugar',NULL,6,260,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-3816c7a4-9e4','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Sweet Sugar (Cnsouka Remix)','sweet sugar (cnsouka remix)',NULL,7,274,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-4badae1e-905','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Sinkstar','sinkstar',NULL,8,313,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-76a883ca-3bf','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Skit~雨~','skit~雨~',NULL,9,138,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-ce765487-f03','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'未来色メロディア','未来色メロディア',NULL,10,232,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-c6bee52c-9c1','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'-未来色メロディア (Cnsouka Remix)（小野道ono/初音ミク Remix）','-未来色メロディア (cnsouka remix)（小野道ono/初音ミク remix）',NULL,11,266,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-e0af1950-909','al-1aee8da1c9','ar-5dfd66d3ef',NULL,'Starline (Eddie▲Yim Chiptune Remix)','starline (eddie▲yim chiptune remix)',NULL,12,289,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-0c3e202c-01e','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Intro','intro',1,1,37,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-0567d785-0b2','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','紙飛行機','紙飛行機',1,2,199,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-89aeea70-b3f','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','わがまま','わがまま',1,3,289,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-57fa1033-0d3','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Iyaiya','iyaiya',1,4,203,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-1efdb7d9-910','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Starline','starline',1,5,275,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-cea5c25d-f6d','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Sweet Sugar','sweet sugar',1,6,260,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-ec82d771-ea3','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Sweet Sugar (Cnsouka Remix)','sweet sugar (cnsouka remix)',1,7,274,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-ef3de1a9-60d','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Sinkstar','sinkstar',1,8,313,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-ecb77afa-b25','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Skit~雨~','skit~雨~',1,9,138,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-0e4b0152-3b4','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','未来色メロディア','未来色メロディア',1,10,232,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-7b76fb43-dab','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','-未来色メロディア (Cnsouka Remix)（小野道ono/初音ミク Remix）','-未来色メロディア (cnsouka remix)（小野道ono/初音ミク remix）',1,11,266,NULL,1790394247);
INSERT INTO song_masters VALUES('sm-upload-d4c28756-862','al-1aee8da1c9','ar-5dfd66d3ef','ar-3a166e5326','Starline (Eddie▲Yim Chiptune Remix)','starline (eddie▲yim chiptune remix)',1,12,289,NULL,1790394247);
INSERT INTO storage_objects VALUES('obj_bd71aad3c93de7ca','objects/obj_bd71aad3c93de7ca.flac',30149031);
INSERT INTO storage_objects VALUES('obj_b6e33e822eaff23e','objects/obj_b6e33e822eaff23e.flac',41049431);
INSERT INTO storage_objects VALUES('obj_bcab08cabd5374c8','objects/obj_bcab08cabd5374c8.flac',28003177);
INSERT INTO storage_objects VALUES('obj_83ebd45266fe13dc','objects/obj_83ebd45266fe13dc.flac',40305813);
INSERT INTO storage_objects VALUES('obj_66284a17fdd11501','objects/obj_66284a17fdd11501.flac',36040630);
INSERT INTO storage_objects VALUES('obj_09491928d0be898f','objects/obj_09491928d0be898f.flac',36921500);
INSERT INTO storage_objects VALUES('obj_b736edce731052b3','objects/obj_b736edce731052b3.flac',37750087);
INSERT INTO storage_objects VALUES('obj_7f4945f7219f9175','objects/obj_7f4945f7219f9175.flac',14075816);
INSERT INTO storage_objects VALUES('obj_f01f73eda7bea44f','objects/obj_f01f73eda7bea44f.flac',29309404);
INSERT INTO storage_objects VALUES('obj_570ca9062c923af7','objects/obj_570ca9062c923af7.flac',34638634);
INSERT INTO storage_objects VALUES('obj_c28c17f78efb2fc2','objects/obj_c28c17f78efb2fc2.flac',37480685);
INSERT INTO storage_objects VALUES('obj_bb1c3f614749c5fe','objects/obj_bb1c3f614749c5fe.mp3',648132);
INSERT INTO storage_objects VALUES('obj_a0b472c67f490fea','objects/obj_a0b472c67f490fea.mp3',3230702);
INSERT INTO storage_objects VALUES('obj_925d3c2b5cdda9ea','objects/obj_925d3c2b5cdda9ea.mp3',4670571);
INSERT INTO storage_objects VALUES('obj_f407dd88bfcb181e','objects/obj_f407dd88bfcb181e.mp3',3290470);
INSERT INTO storage_objects VALUES('obj_e0c8e3cdb361c4c6','objects/obj_e0c8e3cdb361c4c6.mp3',4443202);
INSERT INTO storage_objects VALUES('obj_9fa99b2dbc2949fe','objects/obj_9fa99b2dbc2949fe.mp3',4210816);
INSERT INTO storage_objects VALUES('obj_f85b0088258c1b74','objects/obj_f85b0088258c1b74.mp3',4430663);
INSERT INTO storage_objects VALUES('obj_260fbfa20c0feb4f','objects/obj_260fbfa20c0feb4f.mp3',5060527);
INSERT INTO storage_objects VALUES('obj_ba49b1d9208688b5','objects/obj_ba49b1d9208688b5.mp3',2258529);
INSERT INTO storage_objects VALUES('obj_b90a0a1a4356e96f','objects/obj_b90a0a1a4356e96f.mp3',3759002);
INSERT INTO storage_objects VALUES('obj_f8ff7fb19f835d5b','objects/obj_f8ff7fb19f835d5b.mp3',4310708);
INSERT INTO storage_objects VALUES('obj_7a0b38b3626c1568','objects/obj_7a0b38b3626c1568.mp3',4676005);
INSERT INTO song_instances VALUES('si-upload-c8892b14-597','sm-upload-dc465b39-837','r2-local','original','r2://objects/obj_bd71aad3c93de7ca.flac','obj_bd71aad3c93de7ca','flac',30149031,0,1);
INSERT INTO song_instances VALUES('si-upload-3c949299-993','sm-upload-40be3f1b-142','r2-local','original','r2://objects/obj_b6e33e822eaff23e.flac','obj_b6e33e822eaff23e','flac',41049431,0,1);
INSERT INTO song_instances VALUES('si-upload-d54f5c64-29b','sm-upload-084a7de8-7a9','r2-local','original','r2://objects/obj_bcab08cabd5374c8.flac','obj_bcab08cabd5374c8','flac',28003177,0,1);
INSERT INTO song_instances VALUES('si-upload-39a46df0-dd3','sm-upload-845cba64-1aa','r2-local','original','r2://objects/obj_83ebd45266fe13dc.flac','obj_83ebd45266fe13dc','flac',40305813,0,1);
INSERT INTO song_instances VALUES('si-upload-1fc75fab-267','sm-upload-1c4463de-34c','r2-local','original','r2://objects/obj_66284a17fdd11501.flac','obj_66284a17fdd11501','flac',36040630,0,1);
INSERT INTO song_instances VALUES('si-upload-ee9e4efc-a56','sm-upload-3816c7a4-9e4','r2-local','original','r2://objects/obj_09491928d0be898f.flac','obj_09491928d0be898f','flac',36921500,0,1);
INSERT INTO song_instances VALUES('si-upload-79a0e77d-094','sm-upload-4badae1e-905','r2-local','original','r2://objects/obj_b736edce731052b3.flac','obj_b736edce731052b3','flac',37750087,0,1);
INSERT INTO song_instances VALUES('si-upload-bb960d2e-76b','sm-upload-76a883ca-3bf','r2-local','original','r2://objects/obj_7f4945f7219f9175.flac','obj_7f4945f7219f9175','flac',14075816,0,1);
INSERT INTO song_instances VALUES('si-upload-c637301d-124','sm-upload-ce765487-f03','r2-local','original','r2://objects/obj_f01f73eda7bea44f.flac','obj_f01f73eda7bea44f','flac',29309404,0,1);
INSERT INTO song_instances VALUES('si-upload-8c05ace1-c36','sm-upload-c6bee52c-9c1','r2-local','original','r2://objects/obj_570ca9062c923af7.flac','obj_570ca9062c923af7','flac',34638634,0,1);
INSERT INTO song_instances VALUES('si-upload-2fe3e636-9d8','sm-upload-e0af1950-909','r2-local','original','r2://objects/obj_c28c17f78efb2fc2.flac','obj_c28c17f78efb2fc2','flac',37480685,0,1);
INSERT INTO song_instances VALUES('si-upload-f627a491-948','sm-upload-0c3e202c-01e','r2-local','original','r2://objects/obj_bb1c3f614749c5fe.mp3','obj_bb1c3f614749c5fe','mp3',648132,0,1);
INSERT INTO song_instances VALUES('si-upload-b7fbfd4c-6f9','sm-upload-0567d785-0b2','r2-local','original','r2://objects/obj_a0b472c67f490fea.mp3','obj_a0b472c67f490fea','mp3',3230702,0,1);
INSERT INTO song_instances VALUES('si-upload-98fa6d9e-6c5','sm-upload-89aeea70-b3f','r2-local','original','r2://objects/obj_925d3c2b5cdda9ea.mp3','obj_925d3c2b5cdda9ea','mp3',4670571,0,1);
INSERT INTO song_instances VALUES('si-upload-ea8d6cd3-f10','sm-upload-57fa1033-0d3','r2-local','original','r2://objects/obj_f407dd88bfcb181e.mp3','obj_f407dd88bfcb181e','mp3',3290470,0,1);
INSERT INTO song_instances VALUES('si-upload-e29702e3-33d','sm-upload-1efdb7d9-910','r2-local','original','r2://objects/obj_e0c8e3cdb361c4c6.mp3','obj_e0c8e3cdb361c4c6','mp3',4443202,0,1);
INSERT INTO song_instances VALUES('si-upload-ac9ac335-900','sm-upload-cea5c25d-f6d','r2-local','original','r2://objects/obj_9fa99b2dbc2949fe.mp3','obj_9fa99b2dbc2949fe','mp3',4210816,0,1);
INSERT INTO song_instances VALUES('si-upload-de456bbb-cd6','sm-upload-ec82d771-ea3','r2-local','original','r2://objects/obj_f85b0088258c1b74.mp3','obj_f85b0088258c1b74','mp3',4430663,0,1);
INSERT INTO song_instances VALUES('si-upload-eda274ca-a4e','sm-upload-ef3de1a9-60d','r2-local','original','r2://objects/obj_260fbfa20c0feb4f.mp3','obj_260fbfa20c0feb4f','mp3',5060527,0,1);
INSERT INTO song_instances VALUES('si-upload-871b27ed-31c','sm-upload-ecb77afa-b25','r2-local','original','r2://objects/obj_ba49b1d9208688b5.mp3','obj_ba49b1d9208688b5','mp3',2258529,0,1);
INSERT INTO song_instances VALUES('si-upload-3c756c7e-782','sm-upload-0e4b0152-3b4','r2-local','original','r2://objects/obj_b90a0a1a4356e96f.mp3','obj_b90a0a1a4356e96f','mp3',3759002,0,1);
INSERT INTO song_instances VALUES('si-upload-efb79900-77f','sm-upload-7b76fb43-dab','r2-local','original','r2://objects/obj_f8ff7fb19f835d5b.mp3','obj_f8ff7fb19f835d5b','mp3',4310708,0,1);
INSERT INTO song_instances VALUES('si-upload-3e383939-5f8','sm-upload-d4c28756-862','r2-local','original','r2://objects/obj_7a0b38b3626c1568.mp3','obj_7a0b38b3626c1568','mp3',4676005,0,1);
INSERT INTO storage_entries VALUES('se-f73ac8cc30fa4aeeb37477c5f1833cef','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - 紙飛行機.flac','file','si-upload-c8892b14-597','obj_bd71aad3c93de7ca');
INSERT INTO storage_entries VALUES('se-309c2f7711f14344aa14a5f3b806c587','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - わがまま.flac','file','si-upload-3c949299-993','obj_b6e33e822eaff23e');
INSERT INTO storage_entries VALUES('se-4b25a6e06ce346d19c3577a06172eed1','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Iyaiya.flac','file','si-upload-d54f5c64-29b','obj_bcab08cabd5374c8');
INSERT INTO storage_entries VALUES('se-337585dc86914f89a99411d2be87d3cd','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Starline.flac','file','si-upload-39a46df0-dd3','obj_83ebd45266fe13dc');
INSERT INTO storage_entries VALUES('se-b9414a6fb73b4be4b5e634c4d11e5ce9','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Sweet Sugar.flac','file','si-upload-1fc75fab-267','obj_66284a17fdd11501');
INSERT INTO storage_entries VALUES('se-1b0ea788f38e42b6a1db52e4cd1e375b','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Sweet Sugar (Cnsouka Remix).flac','file','si-upload-ee9e4efc-a56','obj_09491928d0be898f');
INSERT INTO storage_entries VALUES('se-f1c783eae3c24cdab9bbc097ab14e541','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Sinkstar.flac','file','si-upload-79a0e77d-094','obj_b736edce731052b3');
INSERT INTO storage_entries VALUES('se-19eedb08e95f4ec88fcc75cb7ba03621','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Skit~雨~.flac','file','si-upload-bb960d2e-76b','obj_7f4945f7219f9175');
INSERT INTO storage_entries VALUES('se-c806418ac0aa4586b8327dfa33e1192e','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - 未来色メロディア.flac','file','si-upload-c637301d-124','obj_f01f73eda7bea44f');
INSERT INTO storage_entries VALUES('se-8b0e1505ef2340bbadc7b58a365ed9a3','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - -未来色メロディア (Cnsouka Remix)（小野道ono 初音ミク Remix）.flac','file','si-upload-8c05ace1-c36','obj_570ca9062c923af7');
INSERT INTO storage_entries VALUES('se-b11d4e4085084ecabba438745f508465','r2-local','se-4a0352d872394d7d9a496d8c668e0925','Sweet Sugar/flac/小野道ono 初音ミク - Starline (Eddie▲Yim Chiptune Remix).flac','file','si-upload-2fe3e636-9d8','obj_c28c17f78efb2fc2');
INSERT INTO storage_entries VALUES('se-b1e119609041480abf457ffeef8eab6a','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Intro.mp3','file','si-upload-f627a491-948','obj_bb1c3f614749c5fe');
INSERT INTO storage_entries VALUES('se-3a4ec941a6bf44c39c064f85850fcd3e','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - 紙飛行機.mp3','file','si-upload-b7fbfd4c-6f9','obj_a0b472c67f490fea');
INSERT INTO storage_entries VALUES('se-10694f0ac53e47cf87a57835c2979159','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - わがまま.mp3','file','si-upload-98fa6d9e-6c5','obj_925d3c2b5cdda9ea');
INSERT INTO storage_entries VALUES('se-d0a0e2cc39ba423e81e0771a3f6e9715','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Iyaiya.mp3','file','si-upload-ea8d6cd3-f10','obj_f407dd88bfcb181e');
INSERT INTO storage_entries VALUES('se-7f3f9e6bef07411588a5d11253e8b3b8','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Starline.mp3','file','si-upload-e29702e3-33d','obj_e0c8e3cdb361c4c6');
INSERT INTO storage_entries VALUES('se-8306ac83087c44209f787da9162f80d9','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Sweet Sugar.mp3','file','si-upload-ac9ac335-900','obj_9fa99b2dbc2949fe');
INSERT INTO storage_entries VALUES('se-20de9cb9074a4ba481c8ea2940c9100d','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Sweet Sugar (Cnsouka Remix).mp3','file','si-upload-de456bbb-cd6','obj_f85b0088258c1b74');
INSERT INTO storage_entries VALUES('se-2bec94a340dc4eb7a67cbe61b01d810b','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Sinkstar.mp3','file','si-upload-eda274ca-a4e','obj_260fbfa20c0feb4f');
INSERT INTO storage_entries VALUES('se-6da9e47a2bf54043924b81cb6672a70d','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Skit~雨~.mp3','file','si-upload-871b27ed-31c','obj_ba49b1d9208688b5');
INSERT INTO storage_entries VALUES('se-ab41ef7ae27c420f8c27f9e041b44b0c','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - 未来色メロディア.mp3','file','si-upload-3c756c7e-782','obj_b90a0a1a4356e96f');
INSERT INTO storage_entries VALUES('se-0e87998e0e9d4ab397aa2079efd5ad01','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - -未来色メロディア (Cnsouka Remix)（小野道ono 初音ミク Remix）.mp3','file','si-upload-efb79900-77f','obj_f8ff7fb19f835d5b');
INSERT INTO storage_entries VALUES('se-626635456f8948d081abd9a14340e38a','r2-local','se-e9ccdce9df0843a9a25dcacb5e83c36b','Sweet Sugar/mp3/小野道ono 初音ミク - Starline (Eddie▲Yim Chiptune Remix).mp3','file','si-upload-3e383939-5f8','obj_7a0b38b3626c1568');
