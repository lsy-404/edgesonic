-- Guarded D1-only repair for the seven files under 起程转合/wav.
-- All source album, master, instance, object, and logical-path identities must match.
WITH expected(master_id, original_album_id, track_number, instance_id, entry_id, entry_path, object_id, physical_key) AS (
  VALUES
    ('sm-upload-7848fe50-1d6', 'pending-uploads', 1, 'si-upload-fac40ec2-e75', 'se-96b58eca144d4a349ca59d3f302e6501', '起程转合/wav/1.祈程.wav', 'obj_3e279d97f987a649', 'objects/obj_3e279d97f987a649.wav'),
    ('sm-upload-05d63157-24d', 'pending-uploads', 2, 'si-upload-187a1477-feb', 'se-51e379e915ed4dfea77dce91fda44ccd', '起程转合/wav/2.百鸟参临.wav', 'obj_18ae042031188378', 'objects/obj_18ae042031188378.wav'),
    ('sm-upload-ddebd497-12a', 'al-3ff61cef3d', 3, 'si-upload-66f15486-2b8', 'se-c988600f2b2144d2b9c333c202fed2fc', '起程转合/wav/3.真风流.wav', 'obj_48f2941925ec0277', 'objects/obj_48f2941925ec0277.wav'),
    ('sm-upload-85d97fa1-651', 'pending-uploads', 4, 'si-upload-58ef9f26-a8b', 'se-2413bd214bf04100826c5795849e6ed0', '起程转合/wav/4.流浪狂想.wav', 'obj_a4d1749d90d89f2d', 'objects/obj_a4d1749d90d89f2d.wav'),
    ('sm-upload-6409cedf-390', 'pending-uploads', 5, 'si-upload-8227c5d5-70f', 'se-b25227fca19f49b69e2063064a7a4f76', '起程转合/wav/5.空诺.wav', 'obj_98e3cb7a7eef8626', 'objects/obj_98e3cb7a7eef8626.wav'),
    ('sm-upload-4ae38963-7a5', 'pending-uploads', 6, 'si-upload-82ad52ff-570', 'se-016f336d7f1145c9b9fdbcfc7fe620c1', '起程转合/wav/6.点红烛.wav', 'obj_71c38b378c06a4c6', 'objects/obj_71c38b378c06a4c6.wav'),
    ('sm-upload-da9171ca-fd6', 'pending-uploads', 7, 'si-upload-de3a7248-ce6', 'se-ad8c160faa7d45cca92a6f1aef25f0f7', '起程转合/wav/7.兔子先生.wav', 'obj_006cd1819162a809', 'objects/obj_006cd1819162a809.wav')
), valid_source AS (
  SELECT e.master_id
  FROM expected e
  JOIN song_masters sm ON sm.id=e.master_id AND sm.album_id=e.original_album_id AND sm.track IS NULL AND sm.disc IS NULL
  JOIN song_instances si ON si.id=e.instance_id AND si.master_id=sm.id AND si.storage_object_id=e.object_id AND si.storage_uri='r2://' || e.physical_key AND si.missing=0
  JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=si.id AND se.object_id=e.object_id AND se.path=e.entry_path
  JOIN storage_objects so ON so.id=e.object_id AND so.physical_key=e.physical_key
)
INSERT INTO albums (id, name, sort_name, cover_r2_key, song_count, duration, size)
SELECT 'al-524-qichengzhuanhe', '起程转合', '起程转合', 'objects/obj_52c5c2fbd8c092f8.jpg', 7, 1662, 334281538
WHERE NOT EXISTS (SELECT 1 FROM albums WHERE id='al-524-qichengzhuanhe')
  AND (SELECT count(*) FROM valid_source)=7
  AND (SELECT count(*) FROM song_masters WHERE album_id='al-3ff61cef3d')=40
  AND (SELECT count(*) FROM song_masters WHERE album_id='pending-uploads')=692
  AND EXISTS (SELECT 1 FROM albums WHERE id='al-3ff61cef3d' AND name='Pending Uploads' AND song_count=40 AND duration=0 AND size=1985120762)
  AND EXISTS (SELECT 1 FROM albums WHERE id='pending-uploads' AND name='Pending Uploads' AND song_count=692 AND duration=153488 AND size=27080297633)
  AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-b931abaf5cce4531ba5e91243cc35a3f' AND path='起程转合/cover.jpg' AND object_id='obj_52c5c2fbd8c092f8')
  AND EXISTS (SELECT 1 FROM storage_objects WHERE id='obj_52c5c2fbd8c092f8' AND physical_key='objects/obj_52c5c2fbd8c092f8.jpg');

WITH expected(master_id, original_album_id, track_number, instance_id, entry_id, entry_path, object_id, physical_key) AS (
  VALUES
    ('sm-upload-7848fe50-1d6', 'pending-uploads', 1, 'si-upload-fac40ec2-e75', 'se-96b58eca144d4a349ca59d3f302e6501', '起程转合/wav/1.祈程.wav', 'obj_3e279d97f987a649', 'objects/obj_3e279d97f987a649.wav'),
    ('sm-upload-05d63157-24d', 'pending-uploads', 2, 'si-upload-187a1477-feb', 'se-51e379e915ed4dfea77dce91fda44ccd', '起程转合/wav/2.百鸟参临.wav', 'obj_18ae042031188378', 'objects/obj_18ae042031188378.wav'),
    ('sm-upload-ddebd497-12a', 'al-3ff61cef3d', 3, 'si-upload-66f15486-2b8', 'se-c988600f2b2144d2b9c333c202fed2fc', '起程转合/wav/3.真风流.wav', 'obj_48f2941925ec0277', 'objects/obj_48f2941925ec0277.wav'),
    ('sm-upload-85d97fa1-651', 'pending-uploads', 4, 'si-upload-58ef9f26-a8b', 'se-2413bd214bf04100826c5795849e6ed0', '起程转合/wav/4.流浪狂想.wav', 'obj_a4d1749d90d89f2d', 'objects/obj_a4d1749d90d89f2d.wav'),
    ('sm-upload-6409cedf-390', 'pending-uploads', 5, 'si-upload-8227c5d5-70f', 'se-b25227fca19f49b69e2063064a7a4f76', '起程转合/wav/5.空诺.wav', 'obj_98e3cb7a7eef8626', 'objects/obj_98e3cb7a7eef8626.wav'),
    ('sm-upload-4ae38963-7a5', 'pending-uploads', 6, 'si-upload-82ad52ff-570', 'se-016f336d7f1145c9b9fdbcfc7fe620c1', '起程转合/wav/6.点红烛.wav', 'obj_71c38b378c06a4c6', 'objects/obj_71c38b378c06a4c6.wav'),
    ('sm-upload-da9171ca-fd6', 'pending-uploads', 7, 'si-upload-de3a7248-ce6', 'se-ad8c160faa7d45cca92a6f1aef25f0f7', '起程转合/wav/7.兔子先生.wav', 'obj_006cd1819162a809', 'objects/obj_006cd1819162a809.wav')
), valid_source AS (
  SELECT e.master_id
  FROM expected e
  JOIN song_masters sm ON sm.id=e.master_id AND sm.album_id=e.original_album_id AND sm.track IS NULL AND sm.disc IS NULL
  JOIN song_instances si ON si.id=e.instance_id AND si.master_id=sm.id AND si.storage_object_id=e.object_id AND si.storage_uri='r2://' || e.physical_key AND si.missing=0
  JOIN storage_entries se ON se.id=e.entry_id AND se.instance_id=si.id AND se.object_id=e.object_id AND se.path=e.entry_path
  JOIN storage_objects so ON so.id=e.object_id AND so.physical_key=e.physical_key
)
UPDATE song_masters
SET album_id='al-524-qichengzhuanhe', track=(SELECT track_number FROM expected WHERE master_id=song_masters.id), updated_at=unixepoch()
WHERE id IN (SELECT master_id FROM expected)
  AND (SELECT count(*) FROM valid_source)=7
  AND EXISTS (SELECT 1 FROM albums WHERE id='al-524-qichengzhuanhe' AND name='起程转合' AND cover_r2_key='objects/obj_52c5c2fbd8c092f8.jpg')
  AND album_id=(SELECT original_album_id FROM expected WHERE master_id=song_masters.id)
  AND track IS NULL AND disc IS NULL;

UPDATE albums
SET song_count=(SELECT count(*) FROM song_masters WHERE album_id=albums.id),
    duration=(SELECT coalesce(sum(duration),0) FROM song_masters WHERE album_id=albums.id),
    size=(SELECT coalesce(sum(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),
    updated_at=unixepoch()
WHERE id IN ('pending-uploads','al-3ff61cef3d','al-524-qichengzhuanhe')
  AND (SELECT count(*) FROM song_masters WHERE album_id='al-524-qichengzhuanhe' AND track BETWEEN 1 AND 7)=7
  AND (SELECT count(*) FROM song_masters WHERE album_id='al-524-qichengzhuanhe')=7;
