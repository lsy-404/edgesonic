-- Guarded display grouping for two PCM-different WAV alternatives.
-- Run only as one D1 batch after its matching fresh primary preflight.
-- There are no R2, storage_object, storage_entry, or song_instance mutations.

INSERT INTO work_queue(id, task_type, payload, status)
SELECT 'guard-failure', 'metadata', '{}', 'invalid'
WHERE NOT (
  (SELECT COUNT(*) = 1 FROM albums WHERE id = 'al-cb52162ace' AND name = '2024虚拟歌手夏浪派对' AND year = 2024 AND genre = 'VOCALOID' AND cover_r2_key = 'covers/al-cb52162ace' AND song_count = 14 AND duration = 3153 AND size = 397331752)
  AND (SELECT COUNT(*) = 14 FROM song_masters WHERE album_id = 'al-cb52162ace')
  AND (SELECT COUNT(*) = 1 FROM song_masters WHERE id = 'sm-upload-36994a13-b28' AND album_id = 'al-cb52162ace' AND title = '夏花挽浪' AND track = 14 AND disc = 1)
  AND (SELECT COUNT(*) = 1 FROM albums WHERE id = 'al-d5b2b412d8' AND name = '2025虚拟歌手夏浪派对' AND year = 2025 AND genre = 'VOCALOID' AND cover_r2_key = 'covers/al-d5b2b412d8' AND song_count = 17 AND duration = 3706 AND size = 653148224)
  AND (SELECT COUNT(*) = 17 FROM song_masters WHERE album_id = 'al-d5b2b412d8')
  AND (SELECT COUNT(*) = 1 FROM song_masters WHERE id = 'sm-upload-b292b473-d95' AND album_id = 'al-d5b2b412d8' AND title = 'ONE SELF' AND track = 14 AND disc = 1)
  AND (SELECT COUNT(*) = 1 FROM song_masters WHERE id = 'sm-upload-9eb3e1f2-7b3' AND album_id = 'pending-uploads' AND title = '14 ONE SEIF' AND track IS NULL AND disc IS NULL)
  AND (SELECT COUNT(*) = 13 FROM song_masters WHERE id IN (
    'sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5'
  ) AND album_id = 'pending-uploads' AND track IS NULL AND disc IS NULL)
  AND (SELECT COUNT(*) = 13 FROM song_masters WHERE
    (id='sm-upload-0a2c1aa1-d61' AND title='01 海边城') OR (id='sm-upload-a3fa1559-c7c' AND title='02 宅宅不乐水') OR (id='sm-upload-a6b70033-945' AND title='03 粉红色微风') OR (id='sm-upload-cd57e04e-ff9' AND title='04 Metro寄生') OR (id='sm-upload-b68a6ed4-526' AND title='05 空无之雨') OR (id='sm-upload-1b11dd75-443' AND title='06 无所事事的地球爆炸日') OR (id='sm-upload-0173b7aa-4d2' AND title='07 南北缘') OR (id='sm-upload-29f1144e-d59' AND title='08 乌云沏下一座楼') OR (id='sm-upload-e177b11f-4c3' AND title='09 XTAB-心华') OR (id='sm-upload-86659454-78b' AND title='10 非日常Neverland') OR (id='sm-upload-3d910efd-d9a' AND title='11 XYAB-星尘') OR (id='sm-upload-46df7ded-c30' AND title='12 One Take') OR (id='sm-upload-2bc07e10-7f5' AND title='13 倦梦还')
  )
  AND (SELECT COUNT(*) = 15 FROM song_instances WHERE master_id IN (
    'sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5','sm-upload-36994a13-b28','sm-upload-9eb3e1f2-7b3'
  ) AND suffix = 'wav' AND missing = 0 AND storage_object_id IS NOT NULL)
  AND (SELECT COUNT(*) = 15 FROM storage_entries WHERE instance_id IN (
    'si-upload-8cdec54f-e7b','si-upload-b02f0988-242','si-upload-766a1187-ee7','si-upload-9c4b5551-74e','si-upload-fb1d5806-531','si-upload-6900b2fa-01b','si-upload-53c3238a-f2b','si-upload-aec3b976-ff6','si-upload-b9e1d2d2-8c2','si-upload-ac0acfd4-842','si-upload-750f5961-669','si-upload-b841c29f-449','si-upload-e34a9fa2-490','si-upload-365569c0-2ff','si-upload-325339b8-ad8'
  ))
  AND (SELECT COUNT(*) = 0 FROM album_display_group_members WHERE album_id IN ('al-cb52162ace','al-d5b2b412d8'))
  AND (SELECT COUNT(*) = 0 FROM album_display_groups WHERE id IN ('adg-alt-summer-2024','adg-alt-summer-2025') OR display_name IN ('2024虚拟歌手夏浪派对','2025虚拟歌手夏浪派对'))
  AND (SELECT COUNT(*) = 0 FROM albums WHERE id IN ('al-alt-summer-2024-wav','al-alt-summer-2025-one-seif-wav'))
  AND (SELECT COUNT(*) = 0 FROM annotations WHERE (item_type = 'album' AND item_id IN ('al-cb52162ace','al-d5b2b412d8')) OR (item_type = 'song' AND item_id IN ('sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5','sm-upload-36994a13-b28','sm-upload-9eb3e1f2-7b3')))
  AND (SELECT COUNT(*) = 0 FROM bookmarks WHERE song_master_id IN ('sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5','sm-upload-36994a13-b28','sm-upload-9eb3e1f2-7b3'))
  AND (SELECT COUNT(*) = 0 FROM playlist_songs WHERE song_master_id IN ('sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5','sm-upload-36994a13-b28','sm-upload-9eb3e1f2-7b3'))
  AND (SELECT COUNT(*) = 0 FROM share_entries WHERE song_master_id IN ('sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5','sm-upload-36994a13-b28','sm-upload-9eb3e1f2-7b3'))
  AND (SELECT COUNT(*) = 0 FROM work_queue WHERE json_valid(payload) AND json_extract(payload, '$.instanceId') IN ('si-upload-8cdec54f-e7b','si-upload-b02f0988-242','si-upload-766a1187-ee7','si-upload-9c4b5551-74e','si-upload-fb1d5806-531','si-upload-6900b2fa-01b','si-upload-53c3238a-f2b','si-upload-aec3b976-ff6','si-upload-b9e1d2d2-8c2','si-upload-ac0acfd4-842','si-upload-750f5961-669','si-upload-b841c29f-449','si-upload-e34a9fa2-490','si-upload-365569c0-2ff','si-upload-325339b8-ad8') AND status IN ('pending','claimed'))
);

INSERT INTO albums(id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation)
VALUES
  ('al-alt-summer-2024-wav','2024虚拟歌手夏浪派对 (WAV)','2024虚拟歌手夏浪派对',2024,'VOCALOID','covers/al-cb52162ace',14,3179,561466684,0),
  ('al-alt-summer-2025-one-seif-wav','2025虚拟歌手夏浪派对 (WAV alternate — ONE SEIF)','2025虚拟歌手夏浪派对',2025,'VOCALOID','covers/al-d5b2b412d8',1,108,19063004,0);
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard-failure','metadata','{}','invalid' WHERE changes() <> 2;

WITH mapping(wav_id, flac_id, track_no) AS (VALUES
  ('sm-upload-0a2c1aa1-d61','sm-upload-fe8f5b25-096',1),('sm-upload-a3fa1559-c7c','sm-upload-a2ce4299-209',2),('sm-upload-a6b70033-945','sm-upload-fe81cd75-790',3),('sm-upload-cd57e04e-ff9','sm-upload-f25dd748-818',4),('sm-upload-b68a6ed4-526','sm-upload-577d4653-322',5),('sm-upload-1b11dd75-443','sm-upload-913d4012-460',6),('sm-upload-0173b7aa-4d2','sm-upload-675d89b6-7a0',7),('sm-upload-29f1144e-d59','sm-upload-7b88c2f9-c11',8),('sm-upload-e177b11f-4c3','sm-upload-ecabebb7-2d0',9),('sm-upload-86659454-78b','sm-upload-899ab3b1-e19',10),('sm-upload-3d910efd-d9a','sm-upload-37a5469f-c6c',11),('sm-upload-46df7ded-c30','sm-upload-b0b5c1e8-5dc',12),('sm-upload-2bc07e10-7f5','sm-upload-035540a9-62e',13)
)
UPDATE song_masters AS wav
SET album_id='al-alt-summer-2024-wav', track=(SELECT track_no FROM mapping WHERE wav_id=wav.id), disc=1,
    artist_id=(SELECT flac.artist_id FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id),
    album_artist_id=(SELECT flac.album_artist_id FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id),
    genre=(SELECT flac.genre FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id),
    participants=(SELECT flac.participants FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id),
    cover_r2_key=(SELECT flac.cover_r2_key FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id),
    lyrics=(SELECT flac.lyrics FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id),
    lyrics_rich=(SELECT flac.lyrics_rich FROM mapping JOIN song_masters flac ON flac.id=mapping.flac_id WHERE mapping.wav_id=wav.id), updated_at=unixepoch()
WHERE wav.id IN (SELECT wav_id FROM mapping);
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard-failure','metadata','{}','invalid' WHERE changes() <> 13;

WITH mapping(wav_id, flac_id) AS (VALUES
  ('sm-upload-0a2c1aa1-d61','sm-upload-fe8f5b25-096'),('sm-upload-a3fa1559-c7c','sm-upload-a2ce4299-209'),('sm-upload-a6b70033-945','sm-upload-fe81cd75-790'),('sm-upload-cd57e04e-ff9','sm-upload-f25dd748-818'),('sm-upload-b68a6ed4-526','sm-upload-577d4653-322'),('sm-upload-1b11dd75-443','sm-upload-913d4012-460'),('sm-upload-0173b7aa-4d2','sm-upload-675d89b6-7a0'),('sm-upload-29f1144e-d59','sm-upload-7b88c2f9-c11'),('sm-upload-e177b11f-4c3','sm-upload-ecabebb7-2d0'),('sm-upload-86659454-78b','sm-upload-899ab3b1-e19'),('sm-upload-3d910efd-d9a','sm-upload-37a5469f-c6c'),('sm-upload-46df7ded-c30','sm-upload-b0b5c1e8-5dc'),('sm-upload-2bc07e10-7f5','sm-upload-035540a9-62e')
)
INSERT OR IGNORE INTO song_artists(song_id,artist_id,position)
SELECT mapping.wav_id, sa.artist_id, sa.position FROM mapping JOIN song_artists sa ON sa.song_id=mapping.flac_id;
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard-failure','metadata','{}','invalid' WHERE changes() <> 13;

UPDATE song_masters SET album_id='al-alt-summer-2024-wav', updated_at=unixepoch() WHERE id='sm-upload-36994a13-b28';
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard-failure','metadata','{}','invalid' WHERE changes() <> 1;
UPDATE song_masters SET album_id='al-alt-summer-2025-one-seif-wav', track=14, disc=1, updated_at=unixepoch() WHERE id='sm-upload-9eb3e1f2-7b3';
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard-failure','metadata','{}','invalid' WHERE changes() <> 1;

UPDATE albums SET song_count=13,duration=2907,size=353209208,updated_at=unixepoch() WHERE id='al-cb52162ace';
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard-failure','metadata','{}','invalid' WHERE changes() <> 1;

INSERT INTO album_display_groups(id,display_name,sort_name) VALUES
  ('adg-alt-summer-2024','2024虚拟歌手夏浪派对','2024虚拟歌手夏浪派对'),
  ('adg-alt-summer-2025','2025虚拟歌手夏浪派对','2025虚拟歌手夏浪派对');
INSERT INTO album_display_group_members(group_id,album_id,sort_order) VALUES
  ('adg-alt-summer-2024','al-cb52162ace',0),('adg-alt-summer-2024','al-alt-summer-2024-wav',1),
  ('adg-alt-summer-2025','al-d5b2b412d8',0),('adg-alt-summer-2025','al-alt-summer-2025-one-seif-wav',1);

INSERT INTO work_queue(id,task_type,payload,status)
SELECT 'guard-failure','metadata','{}','invalid'
WHERE NOT (
  (SELECT COUNT(*)=13 FROM song_masters WHERE album_id='al-cb52162ace')
  AND (SELECT COUNT(*)=14 FROM song_masters WHERE album_id='al-alt-summer-2024-wav')
  AND (SELECT COUNT(*)=1 FROM song_masters WHERE album_id='al-alt-summer-2025-one-seif-wav' AND id='sm-upload-9eb3e1f2-7b3' AND title='14 ONE SEIF' AND track=14)
  AND (SELECT COUNT(*)=4 FROM album_display_group_members WHERE group_id IN ('adg-alt-summer-2024','adg-alt-summer-2025'))
  AND (SELECT COUNT(*)=15 FROM song_instances WHERE master_id IN ('sm-upload-0a2c1aa1-d61','sm-upload-a3fa1559-c7c','sm-upload-a6b70033-945','sm-upload-cd57e04e-ff9','sm-upload-b68a6ed4-526','sm-upload-1b11dd75-443','sm-upload-0173b7aa-4d2','sm-upload-29f1144e-d59','sm-upload-e177b11f-4c3','sm-upload-86659454-78b','sm-upload-3d910efd-d9a','sm-upload-46df7ded-c30','sm-upload-2bc07e10-7f5','sm-upload-36994a13-b28','sm-upload-9eb3e1f2-7b3') AND suffix='wav' AND missing=0)
  AND (SELECT COUNT(*)=15 FROM storage_entries WHERE instance_id IN ('si-upload-8cdec54f-e7b','si-upload-b02f0988-242','si-upload-766a1187-ee7','si-upload-9c4b5551-74e','si-upload-fb1d5806-531','si-upload-6900b2fa-01b','si-upload-53c3238a-f2b','si-upload-aec3b976-ff6','si-upload-b9e1d2d2-8c2','si-upload-ac0acfd4-842','si-upload-750f5961-669','si-upload-b841c29f-449','si-upload-e34a9fa2-490','si-upload-365569c0-2ff','si-upload-325339b8-ad8'))
);
