WITH expected(master_id,instance_id,object_id,entry_id,track,disc,suffix,size,duration,missing,tag_scanned,title_hex,path_hex,display_name_hex,physical_key) AS (VALUES
('1884','si-mirror-07b059045e40441d','obj_7a56ad794df07ec4ca3be228cf67e1b1','se-687c6c52b396426880d4b6fad902f2c0',1,1,'wav',42064736,236,0,0,'E6A882E59C922D41746C616E7469732D','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30312E20E6A882E59BAD2D41746C616E7469732E776176','30312E20E6A882E59BAD2D41746C616E7469732E776176','objects/obj_7a56ad794df07ec4ca3be228cf67e1b1.wav'),
('sm-upload-769dd389-0fa','si-upload-f8d45bab-41b','obj_41ae41fc76dfcc08','se-f090595eb65a4d549503f228620453fb',1,NULL,'flac',27844332,236,0,1,'E6A882E59C922D41746C616E7469732D205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303120E6A882E59C922D41746C616E7469732D2E666C6163','303120E6A882E59C922D41746C616E7469732D2E666C6163','objects/obj_41ae41fc76dfcc08.flac'),
('1881','si-mirror-0b88052708404a91','obj_9e896c2fad4e1b3a625ac8a1d988877e','se-dce3bf9ef89c41b2a8aab84e756f9a20',2,1,'wav',37525580,211,0,0,'E5B091E5B9B4E6B0B8E6A2A6','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30322E20E5B091E5B9B4E6B0B8E6A2A62E776176','30322E20E5B091E5B9B4E6B0B8E6A2A62E776176','objects/obj_9e896c2fad4e1b3a625ac8a1d988877e.wav'),
('sm-upload-db5124fb-39c','si-upload-283e995f-649','obj_5b29f12db75af88d','se-65270d967e7c4217a7a4518526a6ab85',2,NULL,'flac',23832725,211,0,1,'E5B091E5B9B4E6B0B8E6A2A6205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303220E5B091E5B9B4E6B0B8E6A2A62E666C6163','303220E5B091E5B9B4E6B0B8E6A2A62E666C6163','objects/obj_5b29f12db75af88d.flac'),
('1882','si-mirror-11fafd31bead401e','obj_dd469e9cfbc04ad1','se-458a23b42ada4431892ca163390ec1fc',3,1,'wav',45349474,257,0,1,'E6B0B4E5A4A9E4B880E889B2','E4BA9AE789B9E585B0E89282E696AF2F30332E20E6B0B4E5A4A9E4B880E889B22E776176','30332E20E6B0B4E5A4A9E4B880E889B22E776176','objects/obj_dd469e9cfbc04ad1.wav'),
('alt-atlantis-t03-unbracketed-flac','si-mirror-e0e049e8198f4978','obj_7d00d07bd420e719','se-9c9b16cdcd0c4800a3b4294d34ce1580',3,1,'flac',30408791,257,0,1,'E6B0B4E5A4A9E4B880E889B2205B556E627261636B6574656420464C41432065646974696F6E5D','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F303320E6B0B4E5A4A9E4B880E889B22E666C6163','303320E6B0B4E5A4A9E4B880E889B22E666C6163','objects/obj_7d00d07bd420e719.flac'),
('sm-upload-b3f12b9c-b49','si-upload-49a7a100-d28','obj_c7e43e7eacffb9ea','se-0648efd9dc2d4a6c99fedf70e600c5de',3,NULL,'flac',30223544,257,0,1,'E6B0B4E5A4A9E4B880E889B2205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303320E6B0B4E5A4A9E4B880E889B22E666C6163','303320E6B0B4E5A4A9E4B880E889B22E666C6163','objects/obj_c7e43e7eacffb9ea.flac'),
('1883','si-mirror-5cd4841306e24295','obj_4479c73a8a5d0f1726f7b1072c2a4b8f','se-5065e8c06a8e4dde95c4727ac2349ec7',4,1,'wav',44055306,248,0,0,'E69C88E58589E68E8C','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30342E20E69C88E58589E68E8C2E776176','30342E20E69C88E58589E68E8C2E776176','objects/obj_4479c73a8a5d0f1726f7b1072c2a4b8f.wav'),
('sm-upload-89544f44-f15','si-upload-d88b012b-c6c','obj_ae4a54523263436a','se-6e9231d7b3a745b5aac516f4ed7fe58f',4,NULL,'flac',29789371,248,0,1,'E69C88E58589E68E8C205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303420E69C88E58589E68E8C2E666C6163','303420E69C88E58589E68E8C2E666C6163','objects/obj_ae4a54523263436a.flac'),
('1888','si-mirror-f18841841fee4077','obj_d2556716f16834858da229acac1ecf38','se-79de9f145ff940028e20f0a8b1ec41cf',5,1,'wav',42455288,239,0,0,'5354415254','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30352E2053544152542E776176','30352E2053544152542E776176','objects/obj_d2556716f16834858da229acac1ecf38.wav'),
('sm-upload-0c7e7fb4-d11','si-upload-7af22aba-098','obj_5da31e30461ea152','se-d57208eaf9bd4a96908895d721b85084',5,NULL,'flac',28352487,239,0,1,'5354415254205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F30352053544152542E666C6163','30352053544152542E666C6163','objects/obj_5da31e30461ea152.flac'),
('1887','si-mirror-faa94080c2e041c5','obj_5d37f5dc460b56651940d7311095cbca','se-5dd60828dbc44535ba01dfdf3d349dec',6,1,'wav',42214838,237,0,0,'E9BE99E5A5B3','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30362E20E9BE99E5A5B32E776176','30362E20E9BE99E5A5B32E776176','objects/obj_5d37f5dc460b56651940d7311095cbca.wav'),
('sm-upload-d446413c-c9a','si-upload-da70b20f-53f','obj_92f571cd24c17606','se-6b59a6bdffa2439fa9887ee945e3a3d3',6,NULL,'flac',24044348,237,0,1,'E9BE99E5A5B3205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303620E9BE99E5A5B32E666C6163','303620E9BE99E5A5B32E666C6163','objects/obj_92f571cd24c17606.flac'),
('1885','si-mirror-674920b80a2946c6','obj_2ab828df62464294a1c3373389e08d9c','se-c96b2774788344d5ba82a79541d76539',7,1,'wav',36789040,206,0,0,'E7BBAEE5879DE79B8F','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30372E20E7BBAEE5879DE79B8F2E776176','30372E20E7BBAEE5879DE79B8F2E776176','objects/obj_2ab828df62464294a1c3373389e08d9c.wav'),
('sm-upload-6648c0aa-0df','si-upload-c1a58cb8-6f0','obj_a6956ce6632004f8','se-267aeae364ce46e3a9a05d7e9eb7fc8b',7,NULL,'flac',22305398,206,0,1,'E7BBAEE5879DE79B8F205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303720E7BBAEE5879DE79B8F2E666C6163','303720E7BBAEE5879DE79B8F2E666C6163','objects/obj_a6956ce6632004f8.flac'),
('1886','si-mirror-b793cb8748074dae','obj_689c4310301669ed7d10f0a17f33cec5','se-c960fe6f44a1488fa84f4e38eb0e49d6',8,1,'wav',44219384,249,0,0,'E9998DE4B8B4','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30382E20E9998DE4B8B42E776176','30382E20E9998DE4B8B42E776176','objects/obj_689c4310301669ed7d10f0a17f33cec5.wav'),
('sm-upload-6d9c50f0-e53','si-upload-773bf44c-958','obj_b3384b8e314bd4d2','se-999a243e51d94dabb563c2a445e63029',8,NULL,'flac',27934263,249,0,1,'E9998DE4B8B4205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303820E9998DE4B8B42E666C6163','303820E9998DE4B8B42E666C6163','objects/obj_b3384b8e314bd4d2.flac'))

INSERT INTO work_queue(id,task_type,payload,status)
SELECT 'codex-merge-guard-fail','metadata','{}','guard_failed'
WHERE NOT (
 (SELECT COUNT(*) FROM albums WHERE id='al-eddee4ba83'
  AND hex(CAST(name AS BLOB))='E4BA9AE789B9E585B0E89282E696AF'
  AND hex(CAST(sort_name AS BLOB))='E4BA9AE789B9E585B0E89282E696AF'
  AND year=2018
  AND genre IS NULL
  AND cover_r2_key='covers/al-eddee4ba83'
  AND song_count=17 AND duration=4023 AND size=579408905
  AND compilation=0 AND created_at=1784236674 AND updated_at=1790354905)=1
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-eddee4ba83')=17
 AND (SELECT COUNT(*) FROM expected e
      JOIN song_masters sm ON sm.id=e.master_id
      JOIN song_instances si ON si.id=e.instance_id AND si.master_id=sm.id
      JOIN storage_objects so ON so.id=e.object_id
      JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=si.id
      WHERE sm.album_id='al-eddee4ba83'
       AND sm.track=e.track AND sm.duration=e.duration AND hex(CAST(sm.title AS BLOB))=e.title_hex
       AND ((sm.disc IS NULL AND e.disc IS NULL) OR sm.disc=e.disc)
       AND si.storage_object_id=e.object_id AND lower(si.suffix)=e.suffix AND si.size=e.size
       AND si.missing=e.missing AND si.tag_scanned=e.tag_scanned
       AND so.physical_key=e.physical_key AND so.size=e.size
       AND se.kind='file' AND se.object_id=e.object_id
       AND hex(CAST(se.path AS BLOB))=e.path_hex
       AND hex(CAST(se.display_name AS BLOB))=e.display_name_hex)=17
 AND (SELECT COUNT(*) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-eddee4ba83')=17
 AND (SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-eddee4ba83' AND se.kind='file')=17
 AND (SELECT COUNT(*) FROM storage_objects so JOIN song_instances si ON si.storage_object_id=so.id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-eddee4ba83')=17
 AND (SELECT COUNT(*) FROM albums WHERE id IN ('al-atlantis-bracketed-edition','al-atlantis-unbracketed-track3'))=0
 AND (SELECT COUNT(*) FROM album_display_groups WHERE id='group-atlantis-editions')=0
 AND (SELECT COUNT(*) FROM album_display_group_members WHERE album_id IN ('al-eddee4ba83','al-atlantis-bracketed-edition','al-atlantis-unbracketed-track3'))=0
 AND (SELECT COUNT(*) FROM annotations WHERE item_id IN (SELECT id FROM song_masters WHERE album_id='al-eddee4ba83'))=0
 AND (SELECT COUNT(*) FROM bookmarks WHERE song_master_id IN (SELECT id FROM song_masters WHERE album_id='al-eddee4ba83'))=0
 AND (SELECT COUNT(*) FROM playlist_songs WHERE song_master_id IN (SELECT id FROM song_masters WHERE album_id='al-eddee4ba83'))=0
 AND (SELECT COUNT(*) FROM share_entries WHERE song_master_id IN (SELECT id FROM song_masters WHERE album_id='al-eddee4ba83'))=0
 AND (SELECT COUNT(*) FROM clone_id_map WHERE local_id IN (SELECT id FROM song_masters WHERE album_id='al-eddee4ba83'))=16
 AND (SELECT COUNT(*) FROM work_queue WHERE status IN ('queued','claimed') AND EXISTS (SELECT 1 FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-eddee4ba83' AND work_queue.payload LIKE '%'||si.id||'%'))=0
);

INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation)
SELECT 'al-atlantis-bracketed-edition',name || ' [Bracketed FLAC edition]',COALESCE(sort_name,name) || ' bracketed flac edition',year,genre,cover_r2_key,0,0,0,compilation
FROM albums WHERE id='al-eddee4ba83' AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation)
SELECT 'al-atlantis-unbracketed-track3',name || ' [Unbracketed FLAC track 3 mix]',COALESCE(sort_name,name) || ' unbracketed flac track 3 mix',year,genre,cover_r2_key,0,0,0,compilation
FROM albums WHERE id='al-eddee4ba83' AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

UPDATE albums SET name=name || ' [WAV edition]',sort_name=COALESCE(sort_name,name) || ' wav edition',updated_at=unixepoch()
WHERE id='al-eddee4ba83' AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

UPDATE song_masters SET album_id='al-atlantis-bracketed-edition',updated_at=unixepoch()
WHERE id IN ('sm-upload-769dd389-0fa','sm-upload-db5124fb-39c','sm-upload-b3f12b9c-b49','sm-upload-89544f44-f15','sm-upload-0c7e7fb4-d11','sm-upload-d446413c-c9a','sm-upload-6648c0aa-0df','sm-upload-6d9c50f0-e53') AND album_id='al-eddee4ba83'
 AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

UPDATE song_masters SET album_id='al-atlantis-unbracketed-track3',updated_at=unixepoch()
WHERE id IN ('alt-atlantis-t03-unbracketed-flac') AND album_id='al-eddee4ba83'
 AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

UPDATE albums SET
 song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id='al-eddee4ba83'),
 duration=COALESCE((SELECT SUM(duration) FROM song_masters WHERE album_id='al-eddee4ba83'),0),
 size=COALESCE((SELECT SUM(si.size) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-eddee4ba83'),0),
 updated_at=unixepoch()
WHERE id='al-eddee4ba83' AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

UPDATE albums SET
 song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id='al-atlantis-bracketed-edition'),
 duration=COALESCE((SELECT SUM(duration) FROM song_masters WHERE album_id='al-atlantis-bracketed-edition'),0),
 size=COALESCE((SELECT SUM(si.size) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-atlantis-bracketed-edition'),0),
 updated_at=unixepoch()
WHERE id='al-atlantis-bracketed-edition' AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

UPDATE albums SET
 song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id='al-atlantis-unbracketed-track3'),
 duration=COALESCE((SELECT SUM(duration) FROM song_masters WHERE album_id='al-atlantis-unbracketed-track3'),0),
 size=COALESCE((SELECT SUM(si.size) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id='al-atlantis-unbracketed-track3'),0),
 updated_at=unixepoch()
WHERE id='al-atlantis-unbracketed-track3' AND NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

INSERT INTO album_display_groups(id,display_name,sort_name)
SELECT 'group-atlantis-editions',CAST(X'E4BA9AE789B9E585B0E89282E696AF2041746C616E746973' AS TEXT),'atlantis'
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

INSERT INTO album_display_group_members(group_id,album_id,sort_order)
SELECT 'group-atlantis-editions','al-eddee4ba83',0
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');
INSERT INTO album_display_group_members(group_id,album_id,sort_order)
SELECT 'group-atlantis-editions','al-atlantis-bracketed-edition',1
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');
INSERT INTO album_display_group_members(group_id,album_id,sort_order)
SELECT 'group-atlantis-editions','al-atlantis-unbracketed-track3',2
WHERE NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail');

WITH expected(master_id,instance_id,object_id,entry_id,track,disc,suffix,size,duration,missing,tag_scanned,title_hex,path_hex,display_name_hex,physical_key) AS (VALUES
('1884','si-mirror-07b059045e40441d','obj_7a56ad794df07ec4ca3be228cf67e1b1','se-687c6c52b396426880d4b6fad902f2c0',1,1,'wav',42064736,236,0,0,'E6A882E59C922D41746C616E7469732D','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30312E20E6A882E59BAD2D41746C616E7469732E776176','30312E20E6A882E59BAD2D41746C616E7469732E776176','objects/obj_7a56ad794df07ec4ca3be228cf67e1b1.wav'),
('sm-upload-769dd389-0fa','si-upload-f8d45bab-41b','obj_41ae41fc76dfcc08','se-f090595eb65a4d549503f228620453fb',1,NULL,'flac',27844332,236,0,1,'E6A882E59C922D41746C616E7469732D205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303120E6A882E59C922D41746C616E7469732D2E666C6163','303120E6A882E59C922D41746C616E7469732D2E666C6163','objects/obj_41ae41fc76dfcc08.flac'),
('1881','si-mirror-0b88052708404a91','obj_9e896c2fad4e1b3a625ac8a1d988877e','se-dce3bf9ef89c41b2a8aab84e756f9a20',2,1,'wav',37525580,211,0,0,'E5B091E5B9B4E6B0B8E6A2A6','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30322E20E5B091E5B9B4E6B0B8E6A2A62E776176','30322E20E5B091E5B9B4E6B0B8E6A2A62E776176','objects/obj_9e896c2fad4e1b3a625ac8a1d988877e.wav'),
('sm-upload-db5124fb-39c','si-upload-283e995f-649','obj_5b29f12db75af88d','se-65270d967e7c4217a7a4518526a6ab85',2,NULL,'flac',23832725,211,0,1,'E5B091E5B9B4E6B0B8E6A2A6205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303220E5B091E5B9B4E6B0B8E6A2A62E666C6163','303220E5B091E5B9B4E6B0B8E6A2A62E666C6163','objects/obj_5b29f12db75af88d.flac'),
('1882','si-mirror-11fafd31bead401e','obj_dd469e9cfbc04ad1','se-458a23b42ada4431892ca163390ec1fc',3,1,'wav',45349474,257,0,1,'E6B0B4E5A4A9E4B880E889B2','E4BA9AE789B9E585B0E89282E696AF2F30332E20E6B0B4E5A4A9E4B880E889B22E776176','30332E20E6B0B4E5A4A9E4B880E889B22E776176','objects/obj_dd469e9cfbc04ad1.wav'),
('alt-atlantis-t03-unbracketed-flac','si-mirror-e0e049e8198f4978','obj_7d00d07bd420e719','se-9c9b16cdcd0c4800a3b4294d34ce1580',3,1,'flac',30408791,257,0,1,'E6B0B4E5A4A9E4B880E889B2205B556E627261636B6574656420464C41432065646974696F6E5D','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F303320E6B0B4E5A4A9E4B880E889B22E666C6163','303320E6B0B4E5A4A9E4B880E889B22E666C6163','objects/obj_7d00d07bd420e719.flac'),
('sm-upload-b3f12b9c-b49','si-upload-49a7a100-d28','obj_c7e43e7eacffb9ea','se-0648efd9dc2d4a6c99fedf70e600c5de',3,NULL,'flac',30223544,257,0,1,'E6B0B4E5A4A9E4B880E889B2205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303320E6B0B4E5A4A9E4B880E889B22E666C6163','303320E6B0B4E5A4A9E4B880E889B22E666C6163','objects/obj_c7e43e7eacffb9ea.flac'),
('1883','si-mirror-5cd4841306e24295','obj_4479c73a8a5d0f1726f7b1072c2a4b8f','se-5065e8c06a8e4dde95c4727ac2349ec7',4,1,'wav',44055306,248,0,0,'E69C88E58589E68E8C','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30342E20E69C88E58589E68E8C2E776176','30342E20E69C88E58589E68E8C2E776176','objects/obj_4479c73a8a5d0f1726f7b1072c2a4b8f.wav'),
('sm-upload-89544f44-f15','si-upload-d88b012b-c6c','obj_ae4a54523263436a','se-6e9231d7b3a745b5aac516f4ed7fe58f',4,NULL,'flac',29789371,248,0,1,'E69C88E58589E68E8C205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303420E69C88E58589E68E8C2E666C6163','303420E69C88E58589E68E8C2E666C6163','objects/obj_ae4a54523263436a.flac'),
('1888','si-mirror-f18841841fee4077','obj_d2556716f16834858da229acac1ecf38','se-79de9f145ff940028e20f0a8b1ec41cf',5,1,'wav',42455288,239,0,0,'5354415254','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30352E2053544152542E776176','30352E2053544152542E776176','objects/obj_d2556716f16834858da229acac1ecf38.wav'),
('sm-upload-0c7e7fb4-d11','si-upload-7af22aba-098','obj_5da31e30461ea152','se-d57208eaf9bd4a96908895d721b85084',5,NULL,'flac',28352487,239,0,1,'5354415254205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F30352053544152542E666C6163','30352053544152542E666C6163','objects/obj_5da31e30461ea152.flac'),
('1887','si-mirror-faa94080c2e041c5','obj_5d37f5dc460b56651940d7311095cbca','se-5dd60828dbc44535ba01dfdf3d349dec',6,1,'wav',42214838,237,0,0,'E9BE99E5A5B3','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30362E20E9BE99E5A5B32E776176','30362E20E9BE99E5A5B32E776176','objects/obj_5d37f5dc460b56651940d7311095cbca.wav'),
('sm-upload-d446413c-c9a','si-upload-da70b20f-53f','obj_92f571cd24c17606','se-6b59a6bdffa2439fa9887ee945e3a3d3',6,NULL,'flac',24044348,237,0,1,'E9BE99E5A5B3205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303620E9BE99E5A5B32E666C6163','303620E9BE99E5A5B32E666C6163','objects/obj_92f571cd24c17606.flac'),
('1885','si-mirror-674920b80a2946c6','obj_2ab828df62464294a1c3373389e08d9c','se-c96b2774788344d5ba82a79541d76539',7,1,'wav',36789040,206,0,0,'E7BBAEE5879DE79B8F','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30372E20E7BBAEE5879DE79B8F2E776176','30372E20E7BBAEE5879DE79B8F2E776176','objects/obj_2ab828df62464294a1c3373389e08d9c.wav'),
('sm-upload-6648c0aa-0df','si-upload-c1a58cb8-6f0','obj_a6956ce6632004f8','se-267aeae364ce46e3a9a05d7e9eb7fc8b',7,NULL,'flac',22305398,206,0,1,'E7BBAEE5879DE79B8F205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303720E7BBAEE5879DE79B8F2E666C6163','303720E7BBAEE5879DE79B8F2E666C6163','objects/obj_a6956ce6632004f8.flac'),
('1886','si-mirror-b793cb8748074dae','obj_689c4310301669ed7d10f0a17f33cec5','se-c960fe6f44a1488fa84f4e38eb0e49d6',8,1,'wav',44219384,249,0,0,'E9998DE4B8B4','E4BA9AE789B9E585B0E89282E696AF41746C616E7469732F30382E20E9998DE4B8B42E776176','30382E20E9998DE4B8B42E776176','objects/obj_689c4310301669ed7d10f0a17f33cec5.wav'),
('sm-upload-6d9c50f0-e53','si-upload-773bf44c-958','obj_b3384b8e314bd4d2','se-999a243e51d94dabb563c2a445e63029',8,NULL,'flac',27934263,249,0,1,'E9998DE4B8B4205B427261636B6574656420464C41432065646974696F6E5D','E3808EE4BA9AE789B9E585B0E89282E696AF41746C616E746973E3808F2F666C61632F303820E9998DE4B8B42E666C6163','303820E9998DE4B8B42E666C6163','objects/obj_b3384b8e314bd4d2.flac'))

INSERT INTO work_queue(id,task_type,payload,status)
SELECT 'codex-merge-guard-fail','metadata','{}','guard_failed'
WHERE NOT (
 NOT EXISTS(SELECT 1 FROM work_queue WHERE id='codex-merge-guard-fail')
 AND (SELECT COUNT(*) FROM album_display_group_members WHERE group_id='group-atlantis-editions')=3
 AND (SELECT COUNT(*) FROM album_display_groups WHERE id='group-atlantis-editions' AND display_name=CAST(X'E4BA9AE789B9E585B0E89282E696AF2041746C616E746973' AS TEXT))=1
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-eddee4ba83')=8
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-atlantis-bracketed-edition')=8
 AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-atlantis-unbracketed-track3')=1
 AND (SELECT COUNT(*) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN ('al-eddee4ba83','al-atlantis-bracketed-edition','al-atlantis-unbracketed-track3'))=17
 AND (SELECT COUNT(*) FROM storage_entries se JOIN song_instances si ON si.id=se.instance_id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN ('al-eddee4ba83','al-atlantis-bracketed-edition','al-atlantis-unbracketed-track3') AND se.kind='file')=17
 AND (SELECT COUNT(*) FROM storage_objects so JOIN song_instances si ON si.storage_object_id=so.id JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id IN ('al-eddee4ba83','al-atlantis-bracketed-edition','al-atlantis-unbracketed-track3'))=17
 AND (SELECT COUNT(*) FROM albums WHERE id='al-eddee4ba83' AND song_count=8 AND duration=1883 AND size=334673646 AND cover_r2_key='covers/al-eddee4ba83')=1
 AND (SELECT COUNT(*) FROM albums WHERE id='al-atlantis-bracketed-edition' AND song_count=8 AND duration=1883 AND size=214326468 AND cover_r2_key='covers/al-eddee4ba83')=1
 AND (SELECT COUNT(*) FROM albums WHERE id='al-atlantis-unbracketed-track3' AND song_count=1 AND duration=257 AND size=30408791 AND cover_r2_key='covers/al-eddee4ba83')=1
 AND (SELECT COUNT(*) FROM clone_id_map WHERE local_id IN (SELECT id FROM song_masters WHERE album_id IN ('al-eddee4ba83','al-atlantis-bracketed-edition','al-atlantis-unbracketed-track3')))=16
);