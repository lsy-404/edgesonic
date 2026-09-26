-- Preserve the existing WAV objects, instances, and entries while assigning them to a displayable edition.
-- This file intentionally contains no explicit transaction: Wrangler wraps file execution atomically.

INSERT INTO album_display_groups (id, display_name, sort_name, created_at, updated_at)
SELECT
  'ag-q3-flac-wav-20260926',
  CASE WHEN
    (SELECT COUNT(*) FROM song_masters WHERE album_id = 'al-1a27548730') = 9
    AND (SELECT COUNT(*)
         FROM song_masters sm
         JOIN song_instances si ON si.master_id = sm.id
         JOIN storage_objects so ON so.id = si.storage_object_id
         JOIN storage_entries se ON se.instance_id = si.id
         WHERE (sm.id, si.id, so.id, se.id, se.path) IN (
           ('sm-upload-b8fabd82-f0b','si-upload-b2b67d68-1e9','obj_6f5f7eb6b38e540a','se-c469d17528fd48129a266e76bb4d7fa3','平四1-6/平行四界3/01  -粉色柠檬.wav'),
           ('sm-upload-14ec6786-592','si-upload-6f1bc3a4-0d1','obj_3e224dbf7ea72367','se-bed3d9e30b974d8f8ea7edc91165e874','平四1-6/平行四界3/02  - Princess Syndrome.wav'),
           ('sm-upload-55c19ccc-aa2','si-upload-96edf67f-07d','obj_01670fcda29a45b7','se-70f6c244a66e42d18ddcd294d1f105df','平四1-6/平行四界3/03  - Scarlet Drop.wav'),
           ('sm-upload-820671c5-bbe','si-upload-bddf767f-75e','obj_28dec5d5e31a5385','se-fa901183bece4047804408dc60da9656','平四1-6/平行四界3/04  - Hemisphere.wav'),
           ('sm-upload-03ccb298-4a1','si-upload-a9d8a957-241','obj_bd32313e8b2d344b','se-24799201e961499d8cb8ae90b11258c2','平四1-6/平行四界3/05  - Overresonated.wav'),
           ('sm-upload-9a545ddf-565','si-upload-265893d2-568','obj_b5df9c696e9642db','se-48f3222e87e048f4b863560cb6302bb4','平四1-6/平行四界3/06  -共鸣曲.wav'),
           ('sm-upload-dc94f069-0d2','si-upload-ca5f8dd5-d54','obj_3e3105c88a8bd0f4','se-b462fc06b2754b5481115546cc31c3b8','平四1-6/平行四界3/07  -梨花泽泽远山远.wav'),
           ('sm-upload-4bd88968-092','si-upload-c2f0c37b-d5e','obj_2d695562524877fc','se-3e3ae8ad196840489056ac3da3cb1ee9','平四1-6/平行四界3/08  -渊之心.wav'),
           ('sm-upload-bf258535-10a','si-upload-b0162f2a-e49','obj_f416b1299925a47d','se-ca6844d844364d37be4a18d03cb07636','平四1-6/平行四界3/09  -Seattle物语II.wav')
         )) = 9
    AND NOT EXISTS (SELECT 1 FROM album_display_group_members WHERE album_id = 'al-1a27548730')
    AND NOT EXISTS (SELECT 1 FROM albums WHERE id = 'al-q3-wav-20260926')
    AND NOT EXISTS (SELECT 1 FROM album_display_groups WHERE id = 'ag-q3-flac-wav-20260926')
  THEN '平行四界Quadimension 3' ELSE NULL END,
  '平行四界quadimension 3', unixepoch(), unixepoch()
FROM albums
WHERE id = 'al-1a27548730';

INSERT INTO albums (id, name, sort_name, year, genre, song_count, duration, size, compilation, created_at, updated_at)
SELECT 'al-q3-wav-20260926', '平行四界Quadimension 3 (WAV)', '平行四界quadimension 3 wav', year, genre,
       9, 2334, 411729756, compilation, unixepoch(), unixepoch()
FROM albums
WHERE id = 'al-1a27548730'
  AND (SELECT COUNT(*) FROM song_masters WHERE album_id = 'pending-uploads' AND id IN ('sm-upload-b8fabd82-f0b','sm-upload-14ec6786-592','sm-upload-55c19ccc-aa2','sm-upload-820671c5-bbe','sm-upload-03ccb298-4a1','sm-upload-9a545ddf-565','sm-upload-dc94f069-0d2','sm-upload-4bd88968-092','sm-upload-bf258535-10a')) = 9;

UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '495'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '495'), title = (SELECT title FROM song_masters WHERE id = '495'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '495'), track = 1, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '495'), genre = (SELECT genre FROM song_masters WHERE id = '495'), participants = (SELECT participants FROM song_masters WHERE id = '495'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '495'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '495'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '495'), updated_at = unixepoch()
WHERE id = 'sm-upload-b8fabd82-f0b' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-c469d17528fd48129a266e76bb4d7fa3' AND instance_id='si-upload-b2b67d68-1e9' AND object_id='obj_6f5f7eb6b38e540a' AND path='平四1-6/平行四界3/01  -粉色柠檬.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '497'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '497'), title = (SELECT title FROM song_masters WHERE id = '497'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '497'), track = 2, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '497'), genre = (SELECT genre FROM song_masters WHERE id = '497'), participants = (SELECT participants FROM song_masters WHERE id = '497'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '497'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '497'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '497'), updated_at = unixepoch()
WHERE id = 'sm-upload-14ec6786-592' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-bed3d9e30b974d8f8ea7edc91165e874' AND instance_id='si-upload-6f1bc3a4-0d1' AND object_id='obj_3e224dbf7ea72367' AND path='平四1-6/平行四界3/02  - Princess Syndrome.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '496'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '496'), title = (SELECT title FROM song_masters WHERE id = '496'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '496'), track = 3, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '496'), genre = (SELECT genre FROM song_masters WHERE id = '496'), participants = (SELECT participants FROM song_masters WHERE id = '496'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '496'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '496'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '496'), updated_at = unixepoch()
WHERE id = 'sm-upload-55c19ccc-aa2' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-70f6c244a66e42d18ddcd294d1f105df' AND instance_id='si-upload-96edf67f-07d' AND object_id='obj_01670fcda29a45b7' AND path='平四1-6/平行四界3/03  - Scarlet Drop.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '494'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '494'), title = (SELECT title FROM song_masters WHERE id = '494'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '494'), track = 4, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '494'), genre = (SELECT genre FROM song_masters WHERE id = '494'), participants = (SELECT participants FROM song_masters WHERE id = '494'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '494'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '494'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '494'), updated_at = unixepoch()
WHERE id = 'sm-upload-820671c5-bbe' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-fa901183bece4047804408dc60da9656' AND instance_id='si-upload-bddf767f-75e' AND object_id='obj_28dec5d5e31a5385' AND path='平四1-6/平行四界3/04  - Hemisphere.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '491'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '491'), title = (SELECT title FROM song_masters WHERE id = '491'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '491'), track = 5, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '491'), genre = (SELECT genre FROM song_masters WHERE id = '491'), participants = (SELECT participants FROM song_masters WHERE id = '491'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '491'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '491'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '491'), updated_at = unixepoch()
WHERE id = 'sm-upload-03ccb298-4a1' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-24799201e961499d8cb8ae90b11258c2' AND instance_id='si-upload-a9d8a957-241' AND object_id='obj_bd32313e8b2d344b' AND path='平四1-6/平行四界3/05  - Overresonated.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '490'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '490'), title = (SELECT title FROM song_masters WHERE id = '490'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '490'), track = 6, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '490'), genre = (SELECT genre FROM song_masters WHERE id = '490'), participants = (SELECT participants FROM song_masters WHERE id = '490'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '490'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '490'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '490'), updated_at = unixepoch()
WHERE id = 'sm-upload-9a545ddf-565' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-48f3222e87e048f4b863560cb6302bb4' AND instance_id='si-upload-265893d2-568' AND object_id='obj_b5df9c696e9642db' AND path='平四1-6/平行四界3/06  -共鸣曲.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '489'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '489'), title = (SELECT title FROM song_masters WHERE id = '489'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '489'), track = 7, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '489'), genre = (SELECT genre FROM song_masters WHERE id = '489'), participants = (SELECT participants FROM song_masters WHERE id = '489'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '489'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '489'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '489'), updated_at = unixepoch()
WHERE id = 'sm-upload-dc94f069-0d2' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-b462fc06b2754b5481115546cc31c3b8' AND instance_id='si-upload-ca5f8dd5-d54' AND object_id='obj_3e3105c88a8bd0f4' AND path='平四1-6/平行四界3/07  -梨花泽泽远山远.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '492'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '492'), title = (SELECT title FROM song_masters WHERE id = '492'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '492'), track = 8, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '492'), genre = (SELECT genre FROM song_masters WHERE id = '492'), participants = (SELECT participants FROM song_masters WHERE id = '492'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '492'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '492'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '492'), updated_at = unixepoch()
WHERE id = 'sm-upload-4bd88968-092' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-3e3ae8ad196840489056ac3da3cb1ee9' AND instance_id='si-upload-c2f0c37b-d5e' AND object_id='obj_2d695562524877fc' AND path='平四1-6/平行四界3/08  -渊之心.wav');
UPDATE song_masters
SET album_id = 'al-q3-wav-20260926', artist_id = (SELECT artist_id FROM song_masters WHERE id = '493'), album_artist_id = (SELECT album_artist_id FROM song_masters WHERE id = '493'), title = (SELECT title FROM song_masters WHERE id = '493'), sort_title = (SELECT sort_title FROM song_masters WHERE id = '493'), track = 9, disc = 1, duration = (SELECT duration FROM song_masters WHERE id = '493'), genre = (SELECT genre FROM song_masters WHERE id = '493'), participants = (SELECT participants FROM song_masters WHERE id = '493'), lyrics = (SELECT lyrics FROM song_masters WHERE id = '493'), lyrics_rich = (SELECT lyrics_rich FROM song_masters WHERE id = '493'), cover_r2_key = (SELECT cover_r2_key FROM song_masters WHERE id = '493'), updated_at = unixepoch()
WHERE id = 'sm-upload-bf258535-10a' AND album_id = 'pending-uploads' AND EXISTS (SELECT 1 FROM storage_entries WHERE id='se-ca6844d844364d37be4a18d03cb07636' AND instance_id='si-upload-b0162f2a-e49' AND object_id='obj_f416b1299925a47d' AND path='平四1-6/平行四界3/09  -Seattle物语II.wav');

UPDATE albums
SET name = CASE WHEN
  (SELECT COUNT(*) FROM song_masters WHERE album_id='al-q3-wav-20260926' AND disc=1 AND track BETWEEN 1 AND 9) = 9
  AND (SELECT COUNT(*) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id JOIN storage_entries se ON se.instance_id=si.id
       WHERE sm.album_id='al-q3-wav-20260926' AND si.suffix='wav' AND se.path LIKE '平四1-6/平行四界3/%.wav') = 9
  THEN name ELSE NULL END,
  updated_at = unixepoch()
WHERE id='al-q3-wav-20260926';

INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-b8fabd82-f0b', artist_id, position FROM song_artists WHERE song_id='495';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-14ec6786-592', artist_id, position FROM song_artists WHERE song_id='497';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-55c19ccc-aa2', artist_id, position FROM song_artists WHERE song_id='496';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-820671c5-bbe', artist_id, position FROM song_artists WHERE song_id='494';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-03ccb298-4a1', artist_id, position FROM song_artists WHERE song_id='491';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-9a545ddf-565', artist_id, position FROM song_artists WHERE song_id='490';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-dc94f069-0d2', artist_id, position FROM song_artists WHERE song_id='489';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-4bd88968-092', artist_id, position FROM song_artists WHERE song_id='492';
INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) SELECT 'sm-upload-bf258535-10a', artist_id, position FROM song_artists WHERE song_id='493';

INSERT INTO album_display_group_members (group_id, album_id, sort_order)
VALUES ('ag-q3-flac-wav-20260926', 'al-1a27548730', 0);
INSERT INTO album_display_group_members (group_id, album_id, sort_order)
VALUES ('ag-q3-flac-wav-20260926', 'al-q3-wav-20260926', 1);
