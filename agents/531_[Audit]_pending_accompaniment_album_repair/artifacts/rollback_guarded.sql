UPDATE song_masters SET album_id='pending-uploads',disc=NULL,track=NULL,updated_at=unixepoch()
WHERE album_id='al-zhongchong-instrumentals-20260926'
  AND id IN ('sm-upload-952a4b01-774','sm-upload-c54c425c-404','sm-upload-391ea4da-60f','sm-upload-59d96f0d-50e','sm-upload-da84e259-fad','sm-upload-de04b96c-b65','sm-upload-384f06a0-7bc','sm-upload-abc5c460-3c3','sm-upload-5ff4f544-e96','sm-upload-4eb61ba2-766')
  AND (SELECT COUNT(*) FROM song_masters WHERE album_id='al-zhongchong-instrumentals-20260926')=10;
SELECT CASE WHEN changes()=10 THEN 1 ELSE abs(-9223372036854775808) END;
DELETE FROM albums WHERE id='al-zhongchong-instrumentals-20260926' AND NOT EXISTS (SELECT 1 FROM song_masters WHERE album_id='al-zhongchong-instrumentals-20260926');
SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END;
UPDATE albums SET song_count=(SELECT COUNT(*) FROM song_masters WHERE album_id=albums.id),duration=(SELECT COALESCE(SUM(duration),0) FROM song_masters WHERE album_id=albums.id),size=(SELECT COALESCE(SUM(si.size),0) FROM song_instances si JOIN song_masters sm ON sm.id=si.master_id WHERE sm.album_id=albums.id),updated_at=unixepoch() WHERE id='pending-uploads';
SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END;
