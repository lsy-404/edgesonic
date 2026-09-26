BEGIN IMMEDIATE;
CREATE TEMP TABLE candidate(master_id TEXT,instance_id TEXT,object_id TEXT,entry_id TEXT,disc INTEGER,track INTEGER,title TEXT,path TEXT);
INSERT INTO candidate VALUES
('sm-upload-2598e63c-2ca','si-upload-24f22661-f90','obj_61f13c2104e31523','se-3c78a1798a1d4049a9f6624abb8406d7',1,1,'01 WE ARE','Find-Zero/CD 1 人声碟/01 WE ARE.wav'),
('sm-upload-f37ae519-c7e','si-upload-9e39a3bb-588','obj_632790037c287eb3','se-4bebcb2f7e2a49be9b895ffe43ebdf59',1,2,'02 VOCA-LOUDER','Find-Zero/CD 1 人声碟/02 VOCA-LOUDER.wav'),
('sm-upload-07eee833-2ae','si-upload-d644294c-bf2','obj_583b5a4080199fe5','se-5cf083999655423d90382565fcef48f1',1,3,'03 铁架下的花','Find-Zero/CD 1 人声碟/03 铁架下的花.wav'),
('sm-upload-2976f6e8-0e5','si-upload-dfe640e0-f16','obj_d357b97e524bce8c','se-18983de145e94e488a2647fa166aa8d0',1,4,'04 kizuna','Find-Zero/CD 1 人声碟/04 kizuna.wav'),
('sm-upload-fb930280-bd0','si-upload-a831a44c-64c','obj_5c6436c3a0ab834a','se-e89125f34856473fa054f6abf597f69c',1,5,'05 伤者','Find-Zero/CD 1 人声碟/05 伤者.wav'),
('sm-upload-a0dff772-6af','si-upload-852799e5-57c','obj_be5643e234bdf93b','se-c25de451dc514b67a85b5ccddd641d08',1,6,'06 冰川融化之时','Find-Zero/CD 1 人声碟/06 冰川融化之时.wav'),
('sm-upload-ce45113c-0e1','si-upload-44d4a1ac-253','obj_50afbc547fcbd4dc','se-56d0f895ec7d4c6f9629ffa52cbba2dd',1,7,'07 鲸语','Find-Zero/CD 1 人声碟/07 鲸语.wav'),
('sm-upload-204fd292-a26','si-upload-ad1c59cb-63b','obj_36f4aef129ab33c1','se-54251b8b7a254b44b4715f8fae1db3d5',1,8,'08 异世千寻','Find-Zero/CD 1 人声碟/08 异世千寻.wav'),
('sm-upload-79a977c4-e3e','si-upload-b4c50c2a-d02','obj_94663eacc8eab674','se-6d2b4e7641ac4502af81425d61697fe8',1,9,'09 伊始genesis','Find-Zero/CD 1 人声碟/09 伊始genesis.wav'),
('sm-upload-cc0abe56-e0a','si-upload-a6c37b2b-b9c','obj_ef9e80e819463736','se-3e9e8abd4ef14a5ebfcf3f862ae217a5',1,10,'10 樱落斩','Find-Zero/CD 1 人声碟/10 樱落斩.wav'),
('sm-upload-3c0317c7-56f','si-upload-c2e4fd30-9cb','obj_3650bfd3360de9ae','se-7773bcfa490645f88151238de3a36a92',1,11,'11 暗与辉缠绕的囚笼','Find-Zero/CD 1 人声碟/11 暗与辉缠绕的囚笼.wav'),
('sm-upload-194e1f87-5a0','si-upload-ab4d457d-865','obj_e6672e6cc80ee707','se-e3def3596b5447f8b9b6fe17bdf79496',1,12,'12 FIND ME $ SAVE US','Find-Zero/CD 1 人声碟/12 FIND ME $ SAVE US.wav'),
('sm-upload-235d5cf2-cff','si-upload-743e6adc-3e2','obj_fe87584ae6309a01','se-0978e3afe298484ea629300055a270a8',1,13,'13 全息投影的脉搏','Find-Zero/CD 1 人声碟/13 全息投影的脉搏.wav'),
('sm-upload-f6144777-6f5','si-upload-ada23f7d-61b','obj_86aec2228a930319','se-1c3d940a8a764a9cad5b1e7b42bc16e1',1,14,'14 褪色的失真','Find-Zero/CD 1 人声碟/14 褪色的失真.wav'),
('sm-upload-2fedb1b9-549','si-upload-19d459e2-6ce','obj_5ada12f66102897f','se-87698538a80b49bcbeb8f6de62dbc785',2,2,'02 VOCA-LOUDER','Find-Zero/CD 2 伴奏碟/02 VOCA-LOUDER.wav'),
('sm-upload-4e52b84c-dda','si-upload-afc31471-5a4','obj_557bafa09f5b51b1','se-76eb83ba2f58454896c6df555a0fc890',2,3,'03 铁架下的花','Find-Zero/CD 2 伴奏碟/03 铁架下的花.wav'),
('sm-upload-566bf3a3-904','si-upload-b2c57428-297','obj_cd591ace1af684a8','se-88d1cf9b7f77419daeb72aee5f764d65',2,4,'04 kizuna','Find-Zero/CD 2 伴奏碟/04 kizuna.wav'),
('sm-upload-ea91bf91-322','si-upload-a66277d0-8f9','obj_ae592afa03000546','se-282fe93bde0c4be2b3899bfc4d0d1b1b',2,5,'05 伤者','Find-Zero/CD 2 伴奏碟/05 伤者.wav'),
('sm-upload-074e690e-1a4','si-upload-53da2b58-a91','obj_18ab12bd16d867e7','se-840629a283334a938f259694125bd3f0',2,6,'06 冰川融化之时','Find-Zero/CD 2 伴奏碟/06 冰川融化之时.wav'),
('sm-upload-63860f31-c7c','si-upload-00e9d8e8-426','obj_44fe13e8e0cdf4a5','se-59e3de7e9e9a411481050d7892f1ef8d',2,8,'08 异世千寻','Find-Zero/CD 2 伴奏碟/08 异世千寻.wav'),
('sm-upload-acde564f-97f','si-upload-03568b9a-07e','obj_e103d5d0ee10ca70','se-b970c36b67424bea8233597b20427af3',2,9,'09 伊始genesis','Find-Zero/CD 2 伴奏碟/09 伊始genesis.wav'),
('sm-upload-e2414f4d-35f','si-upload-39e614c8-3cf','obj_d81defee08c18302','se-46cf221354e14cd4a8c95bc0def1d95c',2,10,'10 樱落斩','Find-Zero/CD 2 伴奏碟/10 樱落斩.wav'),
('sm-upload-9ad469eb-8b6','si-upload-3a2026e4-942','obj_e7dd5be039d944ba','se-40342c1f4fa74bfeb72069de8921bb64',2,11,'11 暗与辉缠绕的囚笼','Find-Zero/CD 2 伴奏碟/11 暗与辉缠绕的囚笼.wav'),
('sm-upload-ce65405a-c12','si-upload-f19ef69c-501','obj_00820ca1e738efa5','se-824965b37ec6409987e1de31d3f82f4a',2,13,'13 全息投影的脉搏','Find-Zero/CD 2 伴奏碟/13 全息投影的脉搏.wav'),
('sm-upload-9fba7239-d56','si-upload-d5b03094-1e9','obj_c20030084650746d','se-990f9b0819ee4662a99da7970e2cafed',2,14,'14 褪色的失真','Find-Zero/CD 2 伴奏碟/14 褪色的失真.wav');
CREATE TEMP TABLE assertion(value INTEGER NOT NULL CHECK(value=1));
INSERT INTO assertion SELECT CASE WHEN
 (SELECT COUNT(*) FROM song_masters sm JOIN candidate c ON c.master_id=sm.id WHERE sm.album_id='al-find-zero-wav' AND sm.disc=c.disc AND sm.track=c.track AND sm.title=c.title)=25 AND
 (SELECT COUNT(*) FROM song_masters WHERE album_id='al-find-zero-wav')=25 AND
 (SELECT COUNT(*) FROM song_instances si JOIN candidate c ON c.instance_id=si.id WHERE si.master_id=c.master_id AND si.storage_object_id=c.object_id)=25 AND
 (SELECT COUNT(*) FROM storage_entries se JOIN candidate c ON c.entry_id=se.id WHERE se.instance_id=c.instance_id AND se.object_id=c.object_id AND se.path=c.path)=25 AND
 EXISTS(SELECT 1 FROM album_display_group_members WHERE group_id='dg-find-zero-editions' AND album_id='al-0494f8ac9c') AND
 EXISTS(SELECT 1 FROM album_display_group_members WHERE group_id='dg-find-zero-editions' AND album_id='al-find-zero-wav') AND
 NOT EXISTS(SELECT 1 FROM candidate c JOIN playlist_songs p ON p.song_master_id=c.master_id) AND
 NOT EXISTS(SELECT 1 FROM candidate c JOIN annotations a ON a.item_type='song' AND a.item_id=c.master_id)
 THEN 1 ELSE 0 END;
UPDATE song_masters SET album_id='pending-uploads',disc=NULL,track=NULL,updated_at=unixepoch() WHERE id IN(SELECT master_id FROM candidate) AND album_id='al-find-zero-wav';
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(si.duration),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_masters sm JOIN song_instances si ON si.master_id=sm.id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id='pending-uploads';
DELETE FROM album_display_groups WHERE id='dg-find-zero-editions';
DELETE FROM albums WHERE id='al-find-zero-wav' AND NOT EXISTS(SELECT 1 FROM song_masters WHERE album_id='al-find-zero-wav');
COMMIT;
