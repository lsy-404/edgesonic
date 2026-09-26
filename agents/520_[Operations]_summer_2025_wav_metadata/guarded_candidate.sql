INSERT INTO work_queue(id,task_type,payload,status)
SELECT 'guard:summer-2025-wav-metadata','metadata','{}','invalid'
WHERE NOT (
  (SELECT count(*) FROM song_masters WHERE id='sm-upload-9eb3e1f2-7b3' AND album_id='al-alt-summer-2025-one-seif-wav' AND title='14 ONE SEIF' AND track=14 AND disc=1 AND artist_id='unknown-artist' AND album_artist_id IS NULL AND genre IS NULL AND lyrics IS NULL AND lyrics_rich IS NULL AND cover_r2_key IS NULL AND duration=108 AND updated_at=1790420345)=1
  AND (SELECT count(*) FROM song_masters WHERE id='sm-upload-b292b473-d95' AND album_id='al-d5b2b412d8' AND title='ONE SELF' AND track=14 AND disc=1 AND artist_id='ar-2b4aeae2d9' AND album_artist_id IS NULL AND genre='VOCALOID' AND length(lyrics)=542 AND lyrics_rich IS NULL AND cover_r2_key IS NULL AND duration=108 AND updated_at=1790386991)=1
  AND (SELECT count(*) FROM song_artists WHERE song_id='sm-upload-b292b473-d95' AND artist_id='ar-2b4aeae2d9' AND position=0)=1
  AND (SELECT count(*) FROM song_artists WHERE song_id='sm-upload-9eb3e1f2-7b3')=0
  AND (SELECT count(*) FROM song_instances WHERE master_id='sm-upload-9eb3e1f2-7b3' AND suffix='wav' AND missing=0 AND storage_object_id IS NOT NULL)=1
  AND (SELECT count(*) FROM album_display_group_members WHERE group_id='adg-alt-summer-2025' AND album_id IN ('al-d5b2b412d8','al-alt-summer-2025-one-seif-wav'))=2
  AND (SELECT count(*) FROM work_queue WHERE json_valid(payload) AND json_extract(payload,'$.instanceId')=(SELECT id FROM song_instances WHERE master_id='sm-upload-9eb3e1f2-7b3') AND status IN ('pending','claimed'))=0
);

UPDATE song_masters
SET artist_id=(SELECT artist_id FROM song_masters WHERE id='sm-upload-b292b473-d95'),
    genre=(SELECT genre FROM song_masters WHERE id='sm-upload-b292b473-d95'),
    lyrics=(SELECT lyrics FROM song_masters WHERE id='sm-upload-b292b473-d95'),
    updated_at=unixepoch()
WHERE id='sm-upload-9eb3e1f2-7b3';
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard:summer-2025-wav-metadata','metadata','{}','invalid' WHERE changes()<>1;

INSERT INTO song_artists(song_id,artist_id,position)
SELECT 'sm-upload-9eb3e1f2-7b3',artist_id,position FROM song_artists WHERE song_id='sm-upload-b292b473-d95';
INSERT INTO work_queue(id,task_type,payload,status) SELECT 'guard:summer-2025-wav-metadata','metadata','{}','invalid' WHERE changes()<>1;

INSERT INTO work_queue(id,task_type,payload,status)
SELECT 'guard:summer-2025-wav-metadata','metadata','{}','invalid'
WHERE NOT (
  (SELECT count(*) FROM song_masters wav JOIN song_masters flac ON flac.id='sm-upload-b292b473-d95' WHERE wav.id='sm-upload-9eb3e1f2-7b3' AND wav.album_id='al-alt-summer-2025-one-seif-wav' AND wav.title='14 ONE SEIF' AND wav.artist_id=flac.artist_id AND wav.genre=flac.genre AND wav.lyrics=flac.lyrics)=1
  AND (SELECT count(*) FROM song_artists WHERE song_id='sm-upload-9eb3e1f2-7b3' AND artist_id='ar-2b4aeae2d9' AND position=0)=1
  AND (SELECT count(*) FROM song_instances WHERE master_id='sm-upload-9eb3e1f2-7b3' AND suffix='wav' AND missing=0)=1
);
