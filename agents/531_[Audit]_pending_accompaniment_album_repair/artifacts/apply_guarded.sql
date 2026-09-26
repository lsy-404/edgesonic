-- Runs atomically through Wrangler. It creates a standalone accompaniment edition only when the captured ten-entry snapshot still matches.
WITH expected(master_id, instance_id, object_id, entry_id, path, track) AS (VALUES
  ('sm-upload-952a4b01-774','si-upload-bbe0cd9c-3bb','obj_81a662744286bbe4','se-4f5f3aeb367840b380d112ec14e1edcc','众虫皆歌/伴奏/001 俯首望槐安(inst no master).wav',1),
  ('sm-upload-c54c425c-404','si-upload-99ad230d-fdc','obj_ef1a57c42dabf481','se-bd273c7cc3d845f3adf98e1cbd0db278','众虫皆歌/伴奏/002 废弃物的空中舞会(inst no master).wav',2),
  ('sm-upload-391ea4da-60f','si-upload-43ad9d5c-d87','obj_2d06f02b79af290f','se-04bf7d63139d49c8966b6a804dffa27f','众虫皆歌/伴奏/003 Lyra·Artist version(inst no master).wav',3),
  ('sm-upload-59d96f0d-50e','si-upload-2c6b391d-d14','obj_68a9dcac70686abb','se-c9ee251c7d784c01acbf25e39c5b4510','众虫皆歌/伴奏/004 主板都市(inst no master).wav',4),
  ('sm-upload-da84e259-fad','si-upload-c24f39bc-147','obj_5d1d13a39e472cc1','se-5e9cd9476ccd406280b9d72c396d3e5e','众虫皆歌/伴奏/005 微光之影(inst no mastered).wav',5),
  ('sm-upload-de04b96c-b65','si-upload-2bf2cb30-332','obj_a2f3b9ef4b8a03a7','se-6e7407525172498a95774fe872d9cd7e','众虫皆歌/伴奏/006 花爱如歌(inst no master).wav',6),
  ('sm-upload-384f06a0-7bc','si-upload-c783c787-de2','obj_1b647cfbb51cec98','se-9c48d0f12abc47b3bdf24db0c141665c','众虫皆歌/伴奏/007 境界、梦归长夏(inst no master).wav',7),
  ('sm-upload-abc5c460-3c3','si-upload-25a2db0c-eb1','obj_38a977a54a057d69','se-9c67d00121cb4a6588376ca35f0fd57d','众虫皆歌/伴奏/008 无拘的秘信(inst no master).wav',8),
  ('sm-upload-5ff4f544-e96','si-upload-e3cd180e-a4a','obj_b63bd41d53fed4d8','se-c1bea43da62247f4be9156395129a7bd','众虫皆歌/伴奏/009 尘埃河外系(inst no master).wav',9),
  ('sm-upload-4eb61ba2-766','si-upload-b37de28b-dc6','obj_de9f07252f361ec9','se-4b0063e2eb3d4389a599737227907ad7','众虫皆歌/伴奏/010 放任雨落·reWritten(inst no master).wav',10)
), guard(ok) AS (
  SELECT COUNT(*) = 10 FROM expected e
  JOIN song_masters sm ON sm.id=e.master_id AND sm.album_id='pending-uploads' AND sm.track IS NULL AND sm.disc IS NULL
  JOIN song_instances si ON si.id=e.instance_id AND si.master_id=e.master_id AND si.storage_object_id=e.object_id AND si.source_id='r2-local' AND si.source_type='original' AND si.suffix='wav' AND si.missing=0 AND si.tag_scanned=1
  JOIN storage_objects so ON so.id=e.object_id AND so.physical_key='objects/' || e.object_id || '.wav'
  JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=e.instance_id AND se.object_id=e.object_id AND se.path=e.path AND se.kind='file'
)
INSERT INTO albums (id,name,sort_name,year,genre,cover_r2_key,song_count,duration,size,compilation,created_at,updated_at)
SELECT 'al-zhongchong-instrumentals-20260926','众虫皆歌（伴奏）','众虫皆歌 伴奏',year,genre,cover_r2_key,10,2037,387655512,compilation,unixepoch(),unixepoch()
FROM albums WHERE id='al-369dc39c99e3a1a27dc05b84aa30d1e1'
  AND (SELECT ok FROM guard)
  AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-369dc39c99e3a1a27dc05b84aa30d1e1')=10
  AND (SELECT song_count FROM albums WHERE id='pending-uploads')=633
  AND NOT EXISTS (SELECT 1 FROM albums WHERE id='al-zhongchong-instrumentals-20260926');

SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END;

WITH expected(master_id, instance_id, object_id, entry_id, path, track) AS (VALUES
  ('sm-upload-952a4b01-774','si-upload-bbe0cd9c-3bb','obj_81a662744286bbe4','se-4f5f3aeb367840b380d112ec14e1edcc','众虫皆歌/伴奏/001 俯首望槐安(inst no master).wav',1),('sm-upload-c54c425c-404','si-upload-99ad230d-fdc','obj_ef1a57c42dabf481','se-bd273c7cc3d845f3adf98e1cbd0db278','众虫皆歌/伴奏/002 废弃物的空中舞会(inst no master).wav',2),('sm-upload-391ea4da-60f','si-upload-43ad9d5c-d87','obj_2d06f02b79af290f','se-04bf7d63139d49c8966b6a804dffa27f','众虫皆歌/伴奏/003 Lyra·Artist version(inst no master).wav',3),('sm-upload-59d96f0d-50e','si-upload-2c6b391d-d14','obj_68a9dcac70686abb','se-c9ee251c7d784c01acbf25e39c5b4510','众虫皆歌/伴奏/004 主板都市(inst no master).wav',4),('sm-upload-da84e259-fad','si-upload-c24f39bc-147','obj_5d1d13a39e472cc1','se-5e9cd9476ccd406280b9d72c396d3e5e','众虫皆歌/伴奏/005 微光之影(inst no mastered).wav',5),('sm-upload-de04b96c-b65','si-upload-2bf2cb30-332','obj_a2f3b9ef4b8a03a7','se-6e7407525172498a95774fe872d9cd7e','众虫皆歌/伴奏/006 花爱如歌(inst no master).wav',6),('sm-upload-384f06a0-7bc','si-upload-c783c787-de2','obj_1b647cfbb51cec98','se-9c48d0f12abc47b3bdf24db0c141665c','众虫皆歌/伴奏/007 境界、梦归长夏(inst no master).wav',7),('sm-upload-abc5c460-3c3','si-upload-25a2db0c-eb1','obj_38a977a54a057d69','se-9c67d00121cb4a6588376ca35f0fd57d','众虫皆歌/伴奏/008 无拘的秘信(inst no master).wav',8),('sm-upload-5ff4f544-e96','si-upload-e3cd180e-a4a','obj_b63bd41d53fed4d8','se-c1bea43da62247f4be9156395129a7bd','众虫皆歌/伴奏/009 尘埃河外系(inst no master).wav',9),('sm-upload-4eb61ba2-766','si-upload-b37de28b-dc6','obj_de9f07252f361ec9','se-4b0063e2eb3d4389a599737227907ad7','众虫皆歌/伴奏/010 放任雨落·reWritten(inst no master).wav',10)
)
UPDATE song_masters SET album_id='al-zhongchong-instrumentals-20260926',disc=1,track=(SELECT track FROM expected WHERE master_id=song_masters.id),updated_at=unixepoch()
WHERE id IN (SELECT master_id FROM expected) AND album_id='pending-uploads'
  AND EXISTS (SELECT 1 FROM albums WHERE id='al-zhongchong-instrumentals-20260926')
  AND (SELECT COUNT(*) FROM expected e JOIN song_instances si ON si.id=e.instance_id AND si.master_id=e.master_id AND si.storage_object_id=e.object_id AND si.missing=0 AND si.tag_scanned=1 JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=e.instance_id AND se.object_id=e.object_id AND se.path=e.path)=10;

SELECT CASE WHEN changes()=10 THEN 1 ELSE abs(-9223372036854775808) END;

UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch()
WHERE id IN ('pending-uploads','al-zhongchong-instrumentals-20260926');

SELECT CASE WHEN changes()=2 THEN 1 ELSE abs(-9223372036854775808) END;
SELECT CASE WHEN
  (SELECT song_count FROM albums WHERE id='al-zhongchong-instrumentals-20260926')=10
  AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-zhongchong-instrumentals-20260926' AND disc=1 AND track BETWEEN 1 AND 10)=10
  AND (SELECT COUNT(*) FROM song_masters WHERE album_id='pending-uploads' AND id IN ('sm-upload-952a4b01-774','sm-upload-c54c425c-404','sm-upload-391ea4da-60f','sm-upload-59d96f0d-50e','sm-upload-da84e259-fad','sm-upload-de04b96c-b65','sm-upload-384f06a0-7bc','sm-upload-abc5c460-3c3','sm-upload-5ff4f544-e96','sm-upload-4eb61ba2-766'))=0
THEN 1 ELSE abs(-9223372036854775808) END;
